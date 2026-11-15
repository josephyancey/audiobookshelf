const crypto = require('crypto')
const { Op } = require('sequelize')
const Logger = require('../Logger')
const Database = require('../Database')
const KepubManager = require('./KepubManager')
const KoboStoreProxy = require('./KoboStoreProxy')
const KoboReadingStateManager = require('./KoboReadingStateManager')
const { buildSyncToken } = require('../utils/kobo/syncToken')
const { buildBookEntitlement, buildBookMetadata, buildRemovedEntitlement, buildTag, buildDeletedTag } = require('../utils/kobo/koboJson')

/** Items per sync page, as Calibre-Web. Larger pages time out on older devices (Calibre-Web #1276). */
const SYNC_ITEM_LIMIT = 100

const KOBO_EBOOK_FORMATS = ['epub', 'kepub']

/**
 * @typedef ScopeItem
 * @property {string} id libraryItemId
 * @property {string} mediaId
 * @property {number} version epoch ms of the latest change to the item or its book
 * @property {'kepub'|'epub'} format the format this device should receive
 * @property {string} ebookPath
 */

/**
 * Builds Kobo library sync pages (docs/kobo-sync/design.md §5).
 *
 * Calibre-Web decides what to send from a per-user "already sent" table that is written while
 * the response is built. That loses books when the device aborts a page (Calibre-Web-Automated
 * #1470), gives a second device nothing (state is per user), and in shelf mode mixes two cursors
 * and skips books (#3218). Here delivery state is per device, every page carries a checkpoint,
 * and a change only counts as delivered once the device presents that checkpoint again.
 */
class KoboSyncManager {
  constructor() {
    /** @type {Map<string, string|null>} ebook path + mtime → rendition layout */
    this.layoutCache = new Map()
  }

  /**
   * Address the device uses for this server. Kobos drop the port from the Host header
   * (Calibre-Web 0411d4a8), so an admin-configured public URL wins.
   *
   * @param {import('express').Request} req
   * @returns {string}
   */
  getBaseUrl(req) {
    return (Database.serverSettings.koboPublicUrl || req.originalHostPrefix || '').replace(/\/+$/, '')
  }

  /**
   * @param {import('express').Request} req
   * @param {string} token
   * @returns {string}
   */
  getDeviceUrl(req, token) {
    return `${this.getBaseUrl(req)}/kobo/${token}`
  }

  /**
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {number}
   */
  getItemVersion(libraryItem) {
    const itemUpdated = libraryItem.updatedAt?.valueOf() || 0
    const mediaUpdated = libraryItem.media?.updatedAt?.valueOf() || 0
    return Math.max(itemUpdated, mediaUpdated)
  }

  /**
   * The cover id changes whenever the item changes, so a new cover reaches the device
   * (Calibre-Web #2509, Calibre-Web-Automated 5fb41dd)
   *
   * @param {string} libraryItemId
   * @param {number} version
   * @returns {string}
   */
  getCoverImageId(libraryItemId, version) {
    return `${libraryItemId}-${Math.floor(version / 1000)}`
  }

  /**
   * @param {string} imageId
   * @returns {string}
   */
  parseCoverImageId(imageId) {
    const match = String(imageId || '').match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    return match ? match[1].toLowerCase() : null
  }

  /**
   * @param {Object} ebookFile
   * @returns {'kepub'|'epub'}
   */
  getDeliveryFormat(ebookFile) {
    if (this.isKepubFile(ebookFile)) return 'kepub'
    return KepubManager.isAvailable() ? 'kepub' : 'epub'
  }

  /**
   * @param {Object} ebookFile
   * @returns {boolean}
   */
  isKepubFile(ebookFile) {
    return ebookFile?.ebookFormat === 'kepub' || /\.kepub(\.epub)?$/i.test(ebookFile?.metadata?.filename || '')
  }

  /**
   * Every library item this device should hold
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @returns {Promise<Map<string, ScopeItem> & { libraryIds?: string[] }>}
   */
  async getScope(user, device) {
    const libraries = await Database.libraryModel.findAll({ attributes: ['id', 'mediaType'] })
    const bookLibraryIds = libraries.filter((library) => library.mediaType === 'book').map((library) => library.id)
    const libraryIds = device.getLibraryIdsToSync(user, bookLibraryIds)
    /** @type {Map<string, ScopeItem> & { libraryIds?: string[] }} */
    const scope = new Map()
    scope.libraryIds = libraryIds
    if (!libraryIds.length) return scope

    const libraryItems = await Database.libraryItemModel.findAll({
      attributes: ['id', 'libraryId', 'mediaId', 'mediaType', 'updatedAt', 'isMissing', 'isInvalid'],
      where: {
        libraryId: libraryIds,
        mediaType: 'book',
        isMissing: { [Op.not]: true },
        isInvalid: { [Op.not]: true }
      },
      include: {
        model: Database.bookModel,
        attributes: ['id', 'updatedAt', 'ebookFile', 'explicit', 'tags'],
        required: true
      }
    })

    let allowedMediaIds = null
    if (device.onlyCollections) {
      const collectionIds = Array.isArray(device.collectionIds) ? device.collectionIds : []
      const collectionBooks = collectionIds.length ? await Database.collectionBookModel.findAll({ attributes: ['bookId'], where: { collectionId: collectionIds } }) : []
      allowedMediaIds = new Set(collectionBooks.map((collectionBook) => collectionBook.bookId))
    }

    for (const libraryItem of libraryItems) {
      const ebookFile = libraryItem.media?.ebookFile
      if (!ebookFile?.metadata?.path || !KOBO_EBOOK_FORMATS.includes(String(ebookFile.ebookFormat || '').toLowerCase())) continue
      if (allowedMediaIds && !allowedMediaIds.has(libraryItem.mediaId)) continue
      if (!user.checkCanAccessLibraryItem(libraryItem)) continue
      scope.set(libraryItem.id, {
        id: libraryItem.id,
        mediaId: libraryItem.mediaId,
        version: this.getItemVersion(libraryItem),
        format: this.getDeliveryFormat(ebookFile),
        ebookPath: ebookFile.metadata.path
      })
    }
    return scope
  }

  /**
   * Fixed-layout epubs must be advertised as EPUB3FL (Calibre-Web 4eaa9413)
   *
   * @param {Object} ebookFile
   * @returns {Promise<string|null>}
   */
  async getLayout(ebookFile) {
    const key = `${ebookFile.metadata.path}:${ebookFile.metadata.mtimeMs || ''}`
    if (this.layoutCache.has(key)) return this.layoutCache.get(key)
    let layout = null
    try {
      layout = await KepubManager.getEpubLayout(ebookFile.metadata.path)
    } catch (error) {
      Logger.warn(`[KoboSyncManager] Could not read layout of "${ebookFile.metadata.path}": ${error.message}`)
    }
    if (this.layoutCache.size > 5000) this.layoutCache.clear()
    this.layoutCache.set(key, layout)
    return layout
  }

  /**
   * DownloadUrls for one item: a single KEPUB when possible, EPUB3 + EPUB otherwise, EPUB3FL for fixed layout
   *
   * @param {string} deviceUrl
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {'kepub'|'epub'} format
   * @returns {Promise<{ urls: Object[], format: 'kepub'|'epub' }>}
   */
  async getDownloadUrls(deviceUrl, libraryItem, format) {
    const ebookFile = libraryItem.media.ebookFile
    const size = Number(ebookFile.metadata?.size) || 0
    const entry = (koboFormat, urlFormat) => ({
      Format: koboFormat,
      Size: size,
      Url: `${deviceUrl}/download/${libraryItem.id}/${urlFormat}`,
      Platform: 'Generic',
      DrmType: 'None'
    })

    if ((await this.getLayout(ebookFile)) === 'pre-paginated') {
      return { urls: [entry('EPUB3FL', 'epub')], format: 'epub' }
    }
    if (format === 'kepub') {
      return { urls: [entry('KEPUB', 'kepub')], format: 'kepub' }
    }
    return { urls: [entry('EPUB3', 'epub'), entry('EPUB', 'epub')], format: 'epub' }
  }

  /**
   * Make every change the device received under its last checkpoint the delivered state
   *
   * @param {import('../models/KoboDevice')} device
   * @param {string|null} checkpoint
   */
  async confirmCheckpoint(device, checkpoint) {
    if (!checkpoint) return
    const items = await Database.koboSyncedItemModel.confirmCheckpoint(device.id, checkpoint)
    const collections = await Database.koboSyncedCollectionModel.confirmCheckpoint(device.id, checkpoint)
    if (items || collections) {
      Logger.debug(`[KoboSyncManager] Device "${device.name}" confirmed ${items} items and ${collections} collections`)
    }
  }

  /**
   * One page of library sync
   *
   * @param {import('express').Request} req
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {import('../utils/kobo/syncToken').KoboSyncToken} token
   * @returns {Promise<{ results: Object[], token: import('../utils/kobo/syncToken').KoboSyncToken, headers: Object<string, string> }>}
   */
  async sync(req, user, device, token) {
    await this.confirmCheckpoint(device, token.checkpoint)

    const checkpoint = crypto.randomUUID()
    const deviceUrl = this.getDeviceUrl(req, req.params.token)
    const scope = await this.getScope(user, device)
    const syncedRows = await Database.koboSyncedItemModel.findAll({ where: { koboDeviceId: device.id } })
    /** @type {Map<string, import('../models/KoboSyncedItem')>} */
    const rowsById = new Map(syncedRows.map((row) => [row.libraryItemId, row]))

    // A device that holds nothing re-reads every reading state too (Calibre-Web 25422b34)
    if (!syncedRows.some((row) => row.deliveredAt && !row.isRemoved)) {
      token.readingStateLastModified = 0
    }

    const { changes, removals } = this.getPendingChanges(scope, rowsById)
    const pageChanges = changes.slice(0, SYNC_ITEM_LIMIT)
    const pageRemovals = removals.slice(0, Math.max(0, SYNC_ITEM_LIMIT - pageChanges.length))
    let hasMore = changes.length + removals.length > pageChanges.length + pageRemovals.length

    const results = []
    const entitledIds = new Set()

    // Entitlements
    const expandedItems = pageChanges.length ? await Database.libraryItemModel.findAllExpandedWhere({ id: pageChanges.map((change) => change.item.id) }) : []
    const expandedById = new Map(expandedItems.map((libraryItem) => [libraryItem.id, libraryItem]))
    for (const change of pageChanges) {
      const libraryItem = expandedById.get(change.item.id)
      if (!libraryItem) continue
      try {
        const { urls, format } = await this.getDownloadUrls(deviceUrl, libraryItem, change.item.format)
        const entitlement = {
          BookEntitlement: buildBookEntitlement(libraryItem, { isRemoved: false }),
          BookMetadata: buildBookMetadata(libraryItem, { downloadUrls: urls, coverImageId: this.getCoverImageId(libraryItem.id, change.item.version) })
        }
        const readingState = await KoboReadingStateManager.getReadingState(user, libraryItem)
        if (readingState) entitlement.ReadingState = readingState
        results.push(change.isNew ? { NewEntitlement: entitlement } : { ChangedEntitlement: entitlement })
        entitledIds.add(libraryItem.id)
        await this.markPending(device, rowsById.get(libraryItem.id), libraryItem.id, checkpoint, { version: change.item.version, format, removed: false })
      } catch (error) {
        // One bad book never fails the whole sync (Calibre-Web lesson 12)
        Logger.error(`[KoboSyncManager] Skipping "${libraryItem.media?.title}" (${libraryItem.id}) in sync: ${error.message}`)
      }
    }

    // Removals: items the device holds that left its scope
    if (pageRemovals.length) {
      const removedItems = await Database.libraryItemModel.findAllExpandedWhere({ id: pageRemovals.map((row) => row.libraryItemId) })
      const removedById = new Map(removedItems.map((libraryItem) => [libraryItem.id, libraryItem]))
      for (const row of pageRemovals) {
        const libraryItem = removedById.get(row.libraryItemId)
        let entitlement = buildRemovedEntitlement(row.libraryItemId)
        if (libraryItem?.media?.ebookFile) {
          try {
            const { urls } = await this.getDownloadUrls(deviceUrl, libraryItem, row.deliveredFormat || 'epub')
            entitlement = {
              BookEntitlement: buildBookEntitlement(libraryItem, { isRemoved: true }),
              BookMetadata: buildBookMetadata(libraryItem, { downloadUrls: urls, coverImageId: this.getCoverImageId(libraryItem.id, this.getItemVersion(libraryItem)) })
            }
          } catch (error) {
            Logger.warn(`[KoboSyncManager] Sending a bare removal for ${row.libraryItemId}: ${error.message}`)
          }
        }
        results.push({ ChangedEntitlement: entitlement })
        await this.markPending(device, row, row.libraryItemId, checkpoint, { version: row.deliveredVersion, format: row.deliveredFormat, removed: true })
      }
    }

    // Reading states changed since the last sync, for books the device holds
    const heldIds = [...scope.keys()].filter((id) => {
      const row = rowsById.get(id)
      return (row?.deliveredAt && !row.isRemoved) || entitledIds.has(id)
    })
    const readingStates = await KoboReadingStateManager.getChangedReadingStates(user, heldIds, token.readingStateLastModified, entitledIds, SYNC_ITEM_LIMIT)
    for (const state of readingStates.states) {
      results.push({ ChangedReadingState: { ReadingState: state } })
    }
    if (readingStates.hasMore) hasMore = true
    token.readingStateLastModified = Math.max(token.readingStateLastModified, readingStates.lastModified)

    // Collections, not paginated (Calibre-Web behavior)
    results.push(...(await this.getTagChanges(user, device, scope, checkpoint)))

    token.checkpoint = checkpoint
    const headers = {}

    // The store's own library goes out with our last page only (Calibre-Web f22e4d99)
    if (!hasMore) {
      const storeSync = await KoboStoreProxy.getStoreSync(req, token.rawKoboStoreToken)
      if (storeSync) {
        results.push(...storeSync.results)
        token.rawKoboStoreToken = storeSync.rawKoboStoreToken
        Object.assign(headers, storeSync.headers)
      }
    }
    if (hasMore) headers['x-kobo-sync'] = 'continue'
    headers['x-kobo-synctoken'] = buildSyncToken(token)

    await device.update({ lastSyncAt: new Date(), lastIp: req.ip || null, lastUserAgent: req.get('user-agent') || null })
    Logger.info(`[KoboSyncManager] Sync for "${user.username}" device "${device.name}": ${entitledIds.size} books, ${pageRemovals.length} removals, ${readingStates.states.length} reading states${hasMore ? ', more to come' : ''}`)
    return { results, token, headers }
  }

  /**
   * What this device is missing: new or changed items in order of change, then removals
   *
   * @param {Map<string, ScopeItem>} scope
   * @param {Map<string, import('../models/KoboSyncedItem')>} rowsById
   * @returns {{ changes: { item: ScopeItem, isNew: boolean }[], removals: import('../models/KoboSyncedItem')[] }}
   */
  getPendingChanges(scope, rowsById) {
    const changes = []
    for (const item of scope.values()) {
      const row = rowsById.get(item.id)
      if (!row || !row.deliveredAt) {
        changes.push({ item, isNew: true })
      } else if (row.isRemoved) {
        // Deleted on the Kobo: stays off this device until a resync (design §12.2).
        // Left the scope and came back: the device no longer has it, so it is new again.
        if (row.removedBy !== 'device') changes.push({ item, isNew: true })
      } else if (item.version > Number(row.deliveredVersion || 0) || item.format !== row.deliveredFormat) {
        changes.push({ item, isNew: false })
      }
    }
    changes.sort((a, b) => a.item.version - b.item.version || a.item.id.localeCompare(b.item.id))

    const removals = []
    for (const row of rowsById.values()) {
      if (!row.deliveredAt || row.isRemoved || scope.has(row.libraryItemId)) continue
      removals.push(row)
    }
    removals.sort((a, b) => a.libraryItemId.localeCompare(b.libraryItemId))
    return { changes, removals }
  }

  /**
   * Record a change as sent under a checkpoint, not yet delivered
   *
   * @param {import('../models/KoboDevice')} device
   * @param {import('../models/KoboSyncedItem')|undefined} row
   * @param {string} libraryItemId
   * @param {string} checkpoint
   * @param {{ version: number, format: string, removed: boolean }} pending
   */
  async markPending(device, row, libraryItemId, checkpoint, pending) {
    const values = {
      pendingCheckpoint: checkpoint,
      pendingVersion: pending.version,
      pendingFormat: pending.format,
      pendingRemoved: pending.removed
    }
    if (row) {
      if (!pending.removed && row.isRemoved) values.removedBy = null
      await row.update(values)
    } else {
      await Database.koboSyncedItemModel.create({ koboDeviceId: device.id, libraryItemId, ...values })
    }
  }

  /**
   * NewTag, ChangedTag and DeletedTag for the collections this device syncs
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {Map<string, ScopeItem>} scope
   * @param {string} checkpoint
   * @returns {Promise<Object[]>}
   */
  async getTagChanges(user, device, scope, checkpoint) {
    const libraryIds = scope.libraryIds || []
    const where = { libraryId: libraryIds }
    if (device.onlyCollections) where.id = Array.isArray(device.collectionIds) ? device.collectionIds : []
    const collections = libraryIds.length ? await Database.collectionModel.findAll({ where, order: [['createdAt', 'ASC']] }) : []

    const mediaIdToItemId = new Map([...scope.values()].map((item) => [item.mediaId, item.id]))
    const collectionBooks = collections.length
      ? await Database.collectionBookModel.findAll({ attributes: ['collectionId', 'bookId', 'order'], where: { collectionId: collections.map((collection) => collection.id) }, order: [['order', 'ASC']] })
      : []
    /** @type {Map<string, string[]>} */
    const itemIdsByCollection = new Map()
    for (const collectionBook of collectionBooks) {
      const itemId = mediaIdToItemId.get(collectionBook.bookId)
      if (!itemId) continue
      if (!itemIdsByCollection.has(collectionBook.collectionId)) itemIdsByCollection.set(collectionBook.collectionId, [])
      itemIdsByCollection.get(collectionBook.collectionId).push(itemId)
    }

    const rows = await Database.koboSyncedCollectionModel.findAll({ where: { koboDeviceId: device.id } })
    const rowsById = new Map(rows.map((row) => [row.collectionId, row]))
    const results = []

    for (const collection of collections) {
      const itemIds = itemIdsByCollection.get(collection.id) || []
      const hash = crypto.createHash('sha1').update(JSON.stringify([collection.name, itemIds])).digest('hex')
      const row = rowsById.get(collection.id)
      const isNew = !row || !row.deliveredHash || row.isDeleted
      if (!isNew && row.deliveredHash === hash) continue
      results.push(isNew ? { NewTag: buildTag(collection, itemIds) } : { ChangedTag: buildTag(collection, itemIds) })
      const values = { pendingCheckpoint: checkpoint, pendingHash: hash, pendingDeleted: false }
      if (row) await row.update(values)
      else await Database.koboSyncedCollectionModel.create({ koboDeviceId: device.id, collectionId: collection.id, ...values })
    }

    const currentIds = new Set(collections.map((collection) => collection.id))
    for (const row of rows) {
      if (currentIds.has(row.collectionId) || row.isDeleted || !row.deliveredHash) continue
      results.push({ DeletedTag: buildDeletedTag(row.collectionId) })
      await row.update({ pendingCheckpoint: checkpoint, pendingHash: row.deliveredHash, pendingDeleted: true })
    }
    return results
  }

  /**
   * "Resync everything": the next sync sends the whole scope as new
   *
   * @param {import('../models/KoboDevice')} device
   */
  async resetDevice(device) {
    await Database.koboSyncedItemModel.destroy({ where: { koboDeviceId: device.id } })
    await Database.koboSyncedCollectionModel.destroy({ where: { koboDeviceId: device.id } })
    Logger.info(`[KoboSyncManager] Device "${device.name}" will receive every book on its next sync`)
  }

  /**
   * The device deleted a book: keep it off this device (design §12.2)
   *
   * @param {import('../models/KoboDevice')} device
   * @param {string} libraryItemId
   * @returns {Promise<boolean>} whether the device had the item
   */
  async markRemovedByDevice(device, libraryItemId) {
    const row = await Database.koboSyncedItemModel.findOne({ where: { koboDeviceId: device.id, libraryItemId } })
    if (!row) return false
    await row.update({
      deliveredAt: row.deliveredAt || new Date(),
      isRemoved: true,
      removedBy: 'device',
      pendingCheckpoint: null,
      pendingVersion: null,
      pendingFormat: null,
      pendingRemoved: null
    })
    return true
  }

  /**
   * Whether this device has been sent the item (used to tell our books from store books)
   *
   * @param {import('../models/KoboDevice')} device
   * @param {string} libraryItemId
   * @returns {Promise<boolean>}
   */
  async isKnownItem(device, libraryItemId) {
    const count = await Database.koboSyncedItemModel.count({ where: { koboDeviceId: device.id, libraryItemId, [Op.or]: [{ deliveredAt: { [Op.ne]: null } }, { pendingCheckpoint: { [Op.ne]: null } }] } })
    return count > 0
  }
}

module.exports = new KoboSyncManager()
