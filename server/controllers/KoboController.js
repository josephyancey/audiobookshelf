const { Request, Response } = require('express')
const crypto = require('crypto')
const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const CacheManager = require('../managers/CacheManager')
const KepubManager = require('../managers/KepubManager')
const KoboStoreProxy = require('../managers/KoboStoreProxy')
const KoboSyncManager = require('../managers/KoboSyncManager')
const KoboReadingStateManager = require('../managers/KoboReadingStateManager')
const KoboCollectionManager = require('../managers/KoboCollectionManager')
const NativeKoboResources = require('../utils/kobo/koboNativeResources')
const { parseSyncToken } = require('../utils/kobo/syncToken')
const { buildBookMetadata, koboTimestamp } = require('../utils/kobo/koboJson')

/**
 * @typedef RequestKoboObject
 * @property {import('../models/User')} user
 * @property {import('../models/KoboDevice')} koboDevice
 *
 * @typedef {Request & RequestKoboObject} KoboRequest
 */

/** Cover widths served to the device, picked by requested height like Calibre-Web's thumbnail sizes */
const COVER_WIDTHS = [
  { maxHeight: 500, width: 300 },
  { maxHeight: 1000, width: 600 },
  { maxHeight: Infinity, width: 1000 }
]

/**
 * Handlers for requests a Kobo makes to `/kobo/<token>/...` (docs/kobo-sync/design.md).
 * Behaviour and JSON shapes follow Calibre-Web's kobo.py (calibre-web-reference.md).
 */
class KoboController {
  constructor() {}

  /**
   * Send JSON the way the device expects it: explicit utf-8 charset (Calibre-Web 7640ac1b)
   *
   * @param {Response} res
   * @param {*} body
   * @param {number} [status]
   */
  sendJson(res, body, status = 200) {
    res.status(status).set('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body))
  }

  /**
   * A library item this device may be served, or null when it is not ours (a store book)
   *
   * @param {KoboRequest} req
   * @param {string} libraryItemId
   * @returns {Promise<import('../models/LibraryItem')|null>}
   */
  async getLibraryItem(req, libraryItemId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(libraryItemId || '')) return null
    const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
    if (!libraryItem || libraryItem.mediaType !== 'book' || !libraryItem.media?.ebookFile) return null
    if (!req.user.checkCanAccessLibraryItem(libraryItem)) return null
    return libraryItem
  }

  /**
   * GET: /kobo/:token
   * The api_endpoint root
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  root(req, res) {
    res.json({})
  }

  /**
   * GET: /kobo/:token/v1/initialization
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async initialization(req, res) {
    const deviceUrl = KoboSyncManager.getDeviceUrl(req, req.params.token)
    const { resources: storeResources, expiredToken } = await KoboStoreProxy.getStoreResources(req)
    if (expiredToken) {
      // The device re-authenticates with the store when it sees this
      return KoboStoreProxy.relay(expiredToken, res)
    }

    const resources = { ...(storeResources || NativeKoboResources) }
    // Always ours, or newer firmware syncs against the store and finds no books (Calibre-Web a9713bd4)
    resources.library_sync = `${deviceUrl}/v1/library/sync`
    resources.image_host = KoboSyncManager.getBaseUrl(req)
    resources.image_url_template = `${deviceUrl}/{ImageId}/{Width}/{Height}/false/image.jpg`
    resources.image_url_quality_template = `${deviceUrl}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`
    if (!KoboStoreProxy.isEnabled) {
      // No Kobo account to fall back on: answer OAuth and reading services ourselves (design §10)
      resources.oauth_host = `${deviceUrl}/oauth`
      resources.reading_services_host = KoboSyncManager.getBaseUrl(req)
    }

    res.set('x-kobo-apitoken', 'e30=')
    this.sendJson(res, { Resources: resources })
  }

  /**
   * Dummy store tokens. The device sends no UserKey when it has no Kobo account (Calibre-Web a1899bf5).
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  sendDummyAuth(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    this.sendJson(res, {
      AccessToken: crypto.randomBytes(24).toString('base64'),
      RefreshToken: crypto.randomBytes(24).toString('base64'),
      TokenType: 'Bearer',
      TrackingId: crypto.randomUUID(),
      UserKey: body.UserKey || ''
    })
  }

  /**
   * POST: /kobo/:token/v1/auth/device, /v1/auth/refresh, /v1/user/add-device
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async auth(req, res) {
    return KoboStoreProxy.redirectOrProxy(req, res, this.sendDummyAuth.bind(this))
  }

  /**
   * GET|POST: /kobo/:token/oauth/*
   * Only reached when store forwarding is off, because oauth_host points here then
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  oauthToken(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const accessToken = crypto.randomBytes(24).toString('base64')
    const refreshToken = crypto.randomBytes(24).toString('base64')
    this.sendJson(res, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: body.scope || '',
      user_id: body.user_id || '',
      AccessToken: accessToken,
      RefreshToken: refreshToken,
      TokenType: 'Bearer'
    })
  }

  /**
   * GET: /kobo/:token/oauth/.well-known/openid-configuration
   * Without a token_endpoint the device asks for "a new token from ''" and cancels its whole sync (Calibre-Web-Automated aa97e0e)
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  oauthDiscovery(req, res) {
    const issuer = `${KoboSyncManager.getDeviceUrl(req, req.params.token)}/oauth`
    this.sendJson(res, {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code', 'token'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'offline_access'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none']
    })
  }

  /**
   * GET: /kobo/:token/v1/library/sync
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async sync(req, res) {
    if (!req.user.canDownload) {
      Logger.warn(`[KoboController] User "${req.user.username}" cannot download, refusing Kobo sync`)
      return res.status(403).send('User does not have download permission')
    }
    const token = parseSyncToken(req.get('x-kobo-synctoken'))
    try {
      const { results, headers } = await KoboSyncManager.sync(req, req.user, req.koboDevice, token)
      res.set(headers)
      this.sendJson(res, results)
    } catch (error) {
      Logger.error(`[KoboController] Sync failed for device "${req.koboDevice.name}"`, error)
      res.status(500).send('Sync failed')
    }
  }

  /**
   * GET: /kobo/:token/v1/library/:itemId/metadata
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async metadata(req, res) {
    const libraryItem = req.user.canDownload ? await this.getLibraryItem(req, req.params.itemId) : null
    if (!libraryItem) return KoboStoreProxy.redirectOrProxy(req, res)
    const scopeFormat = KoboSyncManager.getDeliveryFormat(libraryItem.media.ebookFile)
    const { urls } = await KoboSyncManager.getDownloadUrls(KoboSyncManager.getDeviceUrl(req, req.params.token), libraryItem, scopeFormat)
    const version = KoboSyncManager.getItemVersion(libraryItem)
    this.sendJson(res, [buildBookMetadata(libraryItem, { downloadUrls: urls, coverImageId: KoboSyncManager.getCoverImageId(libraryItem.id, version) })])
  }

  /**
   * GET: /kobo/:token/v1/library/:itemId/state
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async getState(req, res) {
    const libraryItem = await this.getLibraryItem(req, req.params.itemId)
    if (!libraryItem) return KoboStoreProxy.redirectOrProxy(req, res)
    let state = await KoboReadingStateManager.getReadingState(req.user, libraryItem)
    if (!state) {
      const now = koboTimestamp(Date.now())
      state = {
        EntitlementId: libraryItem.id,
        Created: koboTimestamp(libraryItem.addedAt || libraryItem.createdAt),
        LastModified: now,
        PriorityTimestamp: now,
        StatusInfo: { LastModified: now, Status: 'ReadyToRead', TimesStartedReading: 0 },
        Statistics: { LastModified: now },
        CurrentBookmark: { LastModified: now }
      }
    }
    this.sendJson(res, [state])
  }

  /**
   * PUT: /kobo/:token/v1/library/:itemId/state
   * Every key is optional; a missing one never means a 400 (Calibre-Web-Automated #1213)
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async putState(req, res) {
    const libraryItem = await this.getLibraryItem(req, req.params.itemId)
    if (!libraryItem) return KoboStoreProxy.redirectOrProxy(req, res)

    const incoming = Array.isArray(req.body?.ReadingStates) && req.body.ReadingStates[0] && typeof req.body.ReadingStates[0] === 'object' ? req.body.ReadingStates[0] : {}
    const result = await KoboReadingStateManager.applyDeviceState(req.user, libraryItem, incoming).catch((error) => {
      Logger.error(`[KoboController] Failed to apply Kobo reading state for "${libraryItem.media.title}"`, error)
      return { error: 'Failed to save reading state', statusCode: 500 }
    })
    if (result.error) return res.status(result.statusCode || 500).send(result.error)

    // No server-stamped LastModified/PriorityTimestamp in the answer (Calibre-Web PR #3607)
    const update = { EntitlementId: libraryItem.id }
    if (incoming.CurrentBookmark) update.CurrentBookmarkResult = { Result: 'Success' }
    if (incoming.Statistics) update.StatisticsResult = { Result: 'Success' }
    if (incoming.StatusInfo) update.StatusInfoResult = { Result: 'Success' }
    this.sendJson(res, { RequestResult: 'Success', UpdateResults: [update] })
  }

  /**
   * DELETE: /kobo/:token/v1/library/:itemId
   * The user deleted the book on the Kobo: keep it off this device only (design §12.2)
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async deleteItem(req, res) {
    const wasOurs = await KoboSyncManager.markRemovedByDevice(req.koboDevice, req.params.itemId)
    if (!wasOurs) return KoboStoreProxy.redirectOrProxy(req, res)
    Logger.info(`[KoboController] Kobo "${req.koboDevice.name}" removed ${req.params.itemId}`)
    res.status(204).send('')
  }

  /**
   * GET: /kobo/:token/download/:itemId/:format
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async download(req, res) {
    if (!req.user.canDownload) return res.status(403).send('User does not have download permission')
    const libraryItem = await this.getLibraryItem(req, req.params.itemId)
    if (!libraryItem) return res.sendStatus(404)

    const ebookPath = libraryItem.media.ebookFile.metadata.path
    let filePath = ebookPath
    let isKepub = false
    if (req.params.format === 'kepub') {
      const kepubPath = await KepubManager.getKepubPath(libraryItem)
      if (kepubPath) {
        filePath = kepubPath
        isKepub = true
      } else {
        Logger.warn(`[KoboController] No kepub for "${libraryItem.media.title}", serving the epub`)
      }
    }
    if (!(await fs.pathExists(filePath))) return res.sendStatus(404)

    // The Kobo picks its kepub renderer from the .kepub.epub name (Calibre-Web c2474aa9)
    const baseName = (libraryItem.media.title || Path.basename(ebookPath, Path.extname(ebookPath))).replace(/[\\/:*?"<>|]+/g, '_').trim() || libraryItem.id
    const fileName = isKepub ? `${baseName}.kepub.epub` : `${baseName}.epub`
    res.set('Content-Type', 'application/epub+zip')
    res.attachment(fileName)
    Logger.info(`[KoboController] Kobo "${req.koboDevice.name}" downloading "${libraryItem.media.title}" as ${isKepub ? 'kepub' : 'epub'}`)
    try {
      await new Promise((resolve, reject) => res.sendFile(filePath, { headers: { 'Content-Type': 'application/epub+zip' } }, (error) => (error ? reject(error) : resolve())))
      if (isKepub) await KoboReadingStateManager.touchAfterDownload(req.user, libraryItem)
    } catch (error) {
      Logger.error(`[KoboController] Failed to send "${filePath}" to Kobo`, error)
      if (!res.headersSent) res.sendStatus(500)
    }
  }

  /**
   * GET: /kobo/:token/:imageId/:width/:height/:greyscale/image.jpg
   * GET: /kobo/:token/:imageId/:width/:height/:quality/:greyscale/image.jpg
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async cover(req, res) {
    const libraryItemId = KoboSyncManager.parseCoverImageId(req.params.imageId)
    const exists = libraryItemId ? await Database.libraryItemModel.checkExistsById(libraryItemId) : false
    if (!exists) {
      // A store book's cover lives on Kobo's CDN (Calibre-Web 400c7456)
      if (KoboStoreProxy.isEnabled) return res.redirect(307, KoboStoreProxy.getStoreCoverUrl(req.params.imageId, req.params.width, req.params.height))
      return res.sendStatus(404)
    }
    // The height arrives as text, sometimes a literal "{height}" (Calibre-Web d253804a)
    const height = parseInt(req.params.height)
    const width = (COVER_WIDTHS.find((size) => !Number.isFinite(height) || height <= size.maxHeight) || COVER_WIDTHS[0]).width
    return CacheManager.handleCoverCache(res, libraryItemId, { format: 'jpeg', width })
  }

  /**
   * POST: /kobo/:token/v1/library/tags
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async createTag(req, res) {
    const collectionId = await KoboCollectionManager.createFromDevice(req.user, req.koboDevice, req.body || {})
    this.sendJson(res, collectionId, 201)
  }

  /**
   * PUT: /kobo/:token/v1/library/tags/:tagId
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async renameTag(req, res) {
    const collection = await KoboCollectionManager.getCollection(req.user, req.params.tagId)
    if (!collection) return KoboStoreProxy.isEnabled ? KoboStoreProxy.redirectOrProxy(req, res) : res.sendStatus(404)
    await KoboCollectionManager.renameFromDevice(req.user, collection, req.body || {})
    res.status(200).send(' ')
  }

  /**
   * DELETE: /kobo/:token/v1/library/tags/:tagId
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async deleteTag(req, res) {
    const collection = await KoboCollectionManager.getCollection(req.user, req.params.tagId)
    if (!collection) return KoboStoreProxy.isEnabled ? KoboStoreProxy.redirectOrProxy(req, res) : res.sendStatus(404)
    await KoboCollectionManager.deleteFromDevice(req.user, req.koboDevice, collection)
    res.status(200).send(' ')
  }

  /**
   * POST: /kobo/:token/v1/library/tags/:tagId/items
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async addTagItems(req, res) {
    const collection = await KoboCollectionManager.getCollection(req.user, req.params.tagId)
    if (!collection) return res.sendStatus(404)
    await KoboCollectionManager.updateItemsFromDevice(req.user, collection, req.body?.Items, false)
    res.status(201).send('')
  }

  /**
   * POST: /kobo/:token/v1/library/tags/:tagId/items/delete
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async removeTagItems(req, res) {
    const collection = await KoboCollectionManager.getCollection(req.user, req.params.tagId)
    if (!collection) return res.sendStatus(404)
    await KoboCollectionManager.updateItemsFromDevice(req.user, collection, req.body?.Items, true)
    res.status(200).send('')
  }

  /**
   * Anything else the device asks for. A 404 on an unexpected endpoint can make the device
   * abort its whole sync queue (Calibre-Web lesson 13), so never answer one.
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  async fallback(req, res) {
    Logger.debug(`[KoboController] Unhandled Kobo request ${req.method} ${req.path}`)
    return KoboStoreProxy.redirectOrProxy(req, res)
  }

  /**
   * Kobo reading services, called at the site root because the device strips the path from
   * reading_services_host. Only answered when store forwarding is off; otherwise the device
   * talks to Kobo's own reading services. (Calibre-Web-Automated aa97e0e)
   *
   * @param {Request} req
   * @param {Response} res
   * @param {Function} next
   */
  readingServicesStub(req, res, next) {
    const settings = Database.serverSettings
    if (!settings?.koboSyncEnabled || settings.koboStoreProxy !== false) return next()
    const path = req.path
    if (path === '/api/v3/content/checkforchanges') return res.json([])
    if (path.startsWith('/api/v3/content/') && path.endsWith('/annotations')) return res.json({ data: [], totalResults: 0 })
    if (path.startsWith('/api/UserStorage/')) return res.json({})
    if (path.startsWith('/api/internal/notebooks')) return res.json({ data: [], totalResults: 0 })
    next()
  }
}
module.exports = new KoboController()
