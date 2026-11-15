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
const { isUUID } = require('../utils/index')

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
 * Handlers for requests a Kobo makes to `/kobo/<token>/...`.
 * Behaviour and JSON shapes follow Calibre-Web's kobo.py.
 */
class KoboController {
  constructor() {}

  /**
   * A library item this device may be served, or null when it is not ours (a store book)
   *
   * @param {KoboRequest} req
   * @param {string} libraryItemId
   * @returns {Promise<import('../models/LibraryItem')|null>}
   */
  async getLibraryItem(req, libraryItemId) {
    if (!isUUID(libraryItemId)) return null
    const [libraryItem] = await Database.libraryItemModel.findAllExpandedWhere({ id: libraryItemId })
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
      // No Kobo account to fall back on: answer OAuth and reading services ourselves
      resources.oauth_host = `${deviceUrl}/oauth`
      resources.reading_services_host = KoboSyncManager.getBaseUrl(req)
    }

    res.set('x-kobo-apitoken', 'e30=')
    res.json({ Resources: resources })
  }

  /**
   * Dummy store tokens. The device sends no UserKey when it has no Kobo account (Calibre-Web a1899bf5).
   *
   * @param {KoboRequest} req
   * @param {Response} res
   */
  sendDummyAuth(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    res.json({
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
    res.json({
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
    res.json({
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
    const { results, headers } = await KoboSyncManager.sync(req, req.user, req.koboDevice, token)
    res.set(headers)
    res.json(results)
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
    const urls = await KoboSyncManager.getDownloadUrls(KoboSyncManager.getDeviceUrl(req, req.params.token), libraryItem, scopeFormat)
    const version = KoboSyncManager.getItemVersion(libraryItem)
    res.json([buildBookMetadata(libraryItem, { downloadUrls: urls, coverImageId: KoboSyncManager.getCoverImageId(libraryItem.id, version) })])
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
        Created: koboTimestamp(libraryItem.createdAt),
        LastModified: now,
        PriorityTimestamp: now,
        StatusInfo: { LastModified: now, Status: 'ReadyToRead', TimesStartedReading: 0 },
        Statistics: { LastModified: now },
        CurrentBookmark: { LastModified: now }
      }
    }
    res.json([state])
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
    res.json({ RequestResult: 'Success', UpdateResults: [update] })
  }

  /**
   * DELETE: /kobo/:token/v1/library/:itemId
   * The user deleted the book on the Kobo: keep it off this device only
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
    const kepubPath = req.params.format === 'kepub' ? await KepubManager.getKepubPath(libraryItem) : null
    if (req.params.format === 'kepub' && !kepubPath) Logger.warn(`[KoboController] No kepub for "${libraryItem.media.title}", serving the epub`)
    const filePath = kepubPath || ebookPath
    if (!(await fs.pathExists(filePath))) return res.sendStatus(404)

    // The Kobo picks its kepub renderer from the .kepub.epub name (Calibre-Web c2474aa9)
    const baseName = (libraryItem.media.title || Path.basename(ebookPath, Path.extname(ebookPath))).replace(/[\\/:*?"<>|]+/g, '_').trim() || libraryItem.id
    Logger.info(`[KoboController] Kobo "${req.koboDevice.name}" downloading "${libraryItem.media.title}" as ${kepubPath ? 'kepub' : 'epub'}`)
    await new Promise((resolve, reject) => res.download(filePath, `${baseName}${kepubPath ? '.kepub' : ''}.epub`, (error) => (error ? reject(error) : resolve())))
    if (kepubPath) await KoboReadingStateManager.touchAfterDownload(req.user, libraryItem)
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
    res.status(201).json(collectionId)
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
    await KoboCollectionManager.renameFromDevice(req.user, req.koboDevice, collection, req.body || {})
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
    // Also for a collection the device made without permission: a 404 can stall its queue
    if (collection) await KoboCollectionManager.updateItemsFromDevice(req.user, req.koboDevice, collection, req.body?.Items, false)
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
    if (collection) await KoboCollectionManager.updateItemsFromDevice(req.user, req.koboDevice, collection, req.body?.Items, true)
    res.status(200).send('')
  }

  /**
   * Anything else the device asks for. A 404 on an unexpected endpoint can make the device
   * abort its whole sync queue, so never answer one.
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
