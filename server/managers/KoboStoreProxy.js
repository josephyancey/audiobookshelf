const axios = require('axios')
const Logger = require('../Logger')
const Database = require('../Database')

const KOBO_STORE_URL = 'https://storeapi.kobo.com'
const KOBO_CDN_IMAGES_URL = 'https://cdn.kobo.com/book-images'

/** Hop-by-hop headers, plus content-encoding because axios already decoded the body */
const STRIPPED_RESPONSE_HEADERS = new Set(['connection', 'content-encoding', 'content-length', 'transfer-encoding', 'keep-alive'])

/**
 * Forwards what this server does not answer itself to the Kobo store, so purchases, the store
 * and OverDrive keep working on a Kobo pointed at Audiobookshelf. Same rules as Calibre-Web
 * (calibre-web-reference.md §7, Lesson 25):
 * - GET is answered with a 307 to the store, so the device talks to it with its own headers.
 * - Anything else is proxied server side, because a Kobo turns a redirected POST/PUT/DELETE into a GET.
 * - 2 s to connect, 10 s to answer. A store failure never fails the device's request.
 */
class KoboStoreProxy {
  constructor() {}

  /**
   * @returns {boolean}
   */
  get isEnabled() {
    return Database.serverSettings.koboStoreProxy !== false
  }

  /**
   * The store URL for a device request: everything after /kobo/<token>, query string kept
   *
   * @param {import('express').Request} req
   * @returns {string}
   */
  getStoreUrl(req) {
    const marker = `/kobo/${req.params.token}`
    const index = req.originalUrl.indexOf(marker)
    let path = index >= 0 ? req.originalUrl.slice(index + marker.length) : req.url
    if (!path.startsWith('/')) path = `/${path}`
    return `${KOBO_STORE_URL}${path.replace(/\?$/, '')}`
  }

  /**
   * Request headers to forward: the device's own, minus Host
   *
   * @param {import('express').Request} req
   * @returns {Object<string, string>}
   */
  getForwardHeaders(req) {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const name = key.toLowerCase()
      if (name === 'host' || name === 'content-length' || name === 'connection') continue
      headers[key] = value
    }
    return headers
  }

  /**
   * Call the store with the device's request
   *
   * @param {import('express').Request} req
   * @param {{ url?: string, headers?: Object<string, string>, method?: string }} [overrides]
   * @returns {Promise<import('axios').AxiosResponse>}
   */
  request(req, overrides = {}) {
    const method = overrides.method || req.method
    const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase())
    return axios.request({
      url: overrides.url || this.getStoreUrl(req),
      method,
      headers: overrides.headers || this.getForwardHeaders(req),
      data: hasBody ? req.body : undefined,
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'arraybuffer'
    })
  }

  /**
   * Relay a store response to the device
   *
   * @param {import('axios').AxiosResponse} storeResponse
   * @param {import('express').Response} res
   */
  relay(storeResponse, res) {
    for (const [key, value] of Object.entries(storeResponse.headers || {})) {
      if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase()) || value === undefined || value === null) continue
      res.setHeader(key, value)
    }
    res.status(storeResponse.status).send(Buffer.from(storeResponse.data || ''))
  }

  /**
   * Answer a request this server does not handle: forward to the store, or an empty object
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {Function} [fallback] called instead of the `{}` stub when forwarding is off or fails
   */
  async redirectOrProxy(req, res, fallback = null) {
    const stub = () => (fallback ? fallback(req, res) : res.json({}))
    if (!this.isEnabled) return stub()

    if (req.method === 'GET') {
      return res.redirect(307, this.getStoreUrl(req))
    }
    try {
      const storeResponse = await this.request(req)
      return this.relay(storeResponse, res)
    } catch (error) {
      Logger.warn(`[KoboStoreProxy] Kobo store request ${req.method} ${this.getStoreUrl(req)} failed: ${error.message}`)
      return stub()
    }
  }

  /**
   * The store's library sync, merged into the last page of ours
   *
   * @param {import('express').Request} req
   * @param {string} rawKoboStoreToken
   * @returns {Promise<{ results: Object[], rawKoboStoreToken: string, headers: Object<string, string> }|null>}
   */
  async getStoreSync(req, rawKoboStoreToken) {
    if (!this.isEnabled) return null
    const headers = this.getForwardHeaders(req)
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'x-kobo-synctoken') delete headers[key]
    }
    if (rawKoboStoreToken) headers['x-kobo-synctoken'] = rawKoboStoreToken
    try {
      const storeResponse = await this.request(req, { url: `${KOBO_STORE_URL}/v1/library/sync`, headers, method: 'GET' })
      if (storeResponse.status !== 200) {
        Logger.warn(`[KoboStoreProxy] Kobo store sync answered ${storeResponse.status}`)
        return null
      }
      const results = JSON.parse(Buffer.from(storeResponse.data).toString('utf8') || '[]')
      const passHeaders = {}
      for (const name of ['x-kobo-sync', 'x-kobo-sync-mode', 'x-kobo-recent-reads']) {
        // Calibre-Web copies these even when missing, which sends the literal "None"
        if (storeResponse.headers[name]) passHeaders[name] = storeResponse.headers[name]
      }
      return {
        results: Array.isArray(results) ? results : [],
        rawKoboStoreToken: storeResponse.headers['x-kobo-synctoken'] || rawKoboStoreToken || '',
        headers: passHeaders
      }
    } catch (error) {
      Logger.warn(`[KoboStoreProxy] Kobo store sync failed: ${error.message}`)
      return null
    }
  }

  /**
   * The store's /v1/initialization resources
   *
   * @param {import('express').Request} req
   * @returns {Promise<{ resources: Object|null, expiredToken: import('axios').AxiosResponse|null }>}
   */
  async getStoreResources(req) {
    if (!this.isEnabled) return { resources: null, expiredToken: null }
    try {
      const storeResponse = await this.request(req, { url: `${KOBO_STORE_URL}/v1/initialization`, method: 'GET' })
      const json = JSON.parse(Buffer.from(storeResponse.data).toString('utf8') || '{}')
      // The device re-authenticates when it sees this (Calibre-Web-Automated)
      if (json?.ResponseStatus?.ErrorCode === 'ExpiredToken') {
        return { resources: null, expiredToken: storeResponse }
      }
      return { resources: json?.Resources || null, expiredToken: null }
    } catch (error) {
      Logger.warn(`[KoboStoreProxy] Kobo store initialization failed: ${error.message}`)
      return { resources: null, expiredToken: null }
    }
  }

  /**
   * Where the Kobo CDN serves a store book's cover
   *
   * @param {string} imageId
   * @param {string} width
   * @param {string} height
   * @returns {string}
   */
  getStoreCoverUrl(imageId, width, height) {
    return `${KOBO_CDN_IMAGES_URL}/${encodeURIComponent(imageId)}/${encodeURIComponent(width)}/${encodeURIComponent(height)}/false/image.jpg`
  }
}

module.exports = new KoboStoreProxy()
