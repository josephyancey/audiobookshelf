const crypto = require('crypto')
const { Op } = require('sequelize')
const Logger = require('../Logger')
const Database = require('../Database')
const KepubManager = require('./KepubManager')
const KoboStoreProxy = require('./KoboStoreProxy')
const KoboReadingStateManager = require('./KoboReadingStateManager')
const { buildSyncToken } = require('../utils/kobo/syncToken')
const { isUUID } = require('../utils/index')
const { buildBookEntitlement, buildBookMetadata, buildRemovedEntitlement, buildTag, buildDeletedTag } = require('../utils/kobo/koboJson')

/** Items per sync page, as Calibre-Web. Larger pages time out on older devices (Calibre-Web #1276). */
const SYNC_ITEM_LIMIT = 100

/**
 * @typedef ScopeItem
 * @property {string} id libraryItemId
 * @property {string} mediaId
 * @property {number} version epoch ms of the latest change to the item or its book
 * @property {'kepub'|'epub'} format the format this device should receive
 * @property {import('../models/LibraryItem')} libraryItem with createdAt, media id and ebookFile
 *
 * @typedef Scope
 * @property {Map<string, ScopeItem>} items by libraryItemId
 * @property {Set<string>} missingIds items marked missing (e.g. an unmounted share): neither sent nor removed
 * @property {string[]} libraryIds
 */

/**
 * Builds Kobo library sync pages.
 *
 * Calibre-Web decides what to send from a per-user "already sent" table that is written while
 * the response is built. That loses books when the device aborts a page (Calibre-Web-Automated
 * #1470), gives a second device nothing (state is per user), and in shelf mode mixes two cursors
 * and skips books (#3218). Here delivery state is per device, every page carries a checkpoint,
 * and a change only counts as delivered once the device presents that checkpoint again.
 */
class KoboSyncManager {
  constructor() {}

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
    const libraryItemId = String(imageId || '').slice(0, 36).toLowerCase()
    return isUUID(libraryItemId) ? libraryItemId : null
  }

  /**
   * @param {Object} ebookFile
   * @returns {'kepub'|'epub'}
   */
  getDeliveryFormat(ebookFile) {
    return KepubManager.isKepub(ebookFile) || KepubManager.isAvailable() ? 'kepub' : 'epub'
  }

  /**
   * Every library item this device should hold
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @returns {Promise<Scope>}
   */
  async getScope(user, device) {
    const libraries = await Database.libraryModel.findAll({ attributes: ['id'], where: { mediaType: 'book' } })
    const libraryIds = device.getLibraryIdsToSync(user, libraries.map((library) => library.id))
    /** @type {Scope} */
    const scope = { items: new Map(), missingIds: new Set(), libraryIds }
    if (!libraryIds.length) return scope

    const libraryItems = await Database.libraryItemModel.findAll({
      attributes: ['id', 'libraryId', 'mediaId', 'mediaType', 'isMissing', 'createdAt', 'updatedAt'],
      where: {
        libraryId: libraryIds,
        isInvalid: { [Op.not]: true }
      },
      include: {
        model: Database.bookModel,
        attributes: ['id', 'updatedAt', 'ebookFile', 'explicit', 'tags'],
        where: { ebookFile: { [Op.ne]: null } }
      }
    })

    let allowedMediaIds = null
    if (device.onlyCollections) {
      const collectionBooks = await Database.collectionBookModel.findAll({ attributes: ['bookId'], where: { collectionId: device.collectionIds || [] } })
      allowedMediaIds = new Set(collectionBooks.map((collectionBook) => collectionBook.bookId))
    }

    for (const libraryItem of libraryItems) {
      if (libraryItem.isMissing) {
        scope.missingIds.add(libraryItem.id)
        continue
      }
      const ebookFile = libraryItem.media.ebookFile
      // pdf, mobi and the like are not sent, as in Calibre-Web
      if (ebookFile.ebookFormat !== 'epub' || !ebookFile.metadata?.path) continue
      if (allowedMediaIds && !allowedMediaIds.has(libraryItem.mediaId)) continue
      if (!user.checkCanAccessLibraryItem(libraryItem)) continue
      scope.items.set(libraryItem.id, {
        id: libraryItem.id,
        mediaId: libraryItem.mediaId,
        version: this.getItemVersion(libraryItem),
        format: this.getDeliveryFormat(ebookFile),
        libraryItem
      })
    }
    return scope
  }

  /**
   * DownloadUrls for one item: a single KEPUB when possible, EPUB3 + EPUB otherwise, EPUB3FL for fixed layout
   *
   * @param {string} deviceUrl
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {'kepub'|'epub'} format
   * @returns {Promise<Object[]>}
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

    if ((await KepubManager.getEpubLayout(ebookFile.metadata.path)) === 'pre-paginated') return [entry('EPUB3FL', 'epub')]
    if (format === 'kepub') return [entry('KEPUB', 'kepub')]
    return [entry('EPUB3', 'epub'), entry('EPUB', 'epub')]
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
    /** @type {Object[]} koboSyncedItem rows sent under this checkpoint */
    const pendingRows = []
    const addPending = (libraryItemId, version, format, removed) => {
      pendingRows.push({ koboDeviceId: device.id, libraryItemId, pendingCheckpoint: checkpoint, pendingVersion: version, pendingFormat: format, pendingRemoved: removed, removedBy: null })
    }

    // Entitlements
    const expandedItems = pageChanges.length ? await Database.libraryItemModel.findAllExpandedWhere({ id: pageChanges.map((change) => change.item.id) }) : []
    const expandedById = new Map(expandedItems.map((libraryItem) => [libraryItem.id, libraryItem]))
    const progressAndStates = await KoboReadingStateManager.getProgressAndStates(user.id, expandedItems)
    for (const change of pageChanges) {
      const libraryItem = expandedById.get(change.item.id)
      if (!libraryItem) continue
      try {
        const urls = await this.getDownloadUrls(deviceUrl, libraryItem, change.item.format)
        const entitlement = {
          BookEntitlement: buildBookEntitlement(libraryItem, { isRemoved: false }),
          BookMetadata: buildBookMetadata(libraryItem, { downloadUrls: urls, coverImageId: this.getCoverImageId(libraryItem.id, change.item.version) })
        }
        const readingState = await KoboReadingStateManager.getReadingState(user, libraryItem, progressAndStates.get(libraryItem.id))
        if (readingState) entitlement.ReadingState = readingState
        results.push(change.isNew ? { NewEntitlement: entitlement } : { ChangedEntitlement: entitlement })
        entitledIds.add(libraryItem.id)
        addPending(libraryItem.id, change.item.version, change.item.format, false)
      } catch (error) {
        // One bad book never fails the whole sync
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
            const urls = await this.getDownloadUrls(deviceUrl, libraryItem, row.deliveredFormat || 'epub')
            entitlement = {
              BookEntitlement: buildBookEntitlement(libraryItem, { isRemoved: true }),
              BookMetadata: buildBookMetadata(libraryItem, { downloadUrls: urls, coverImageId: this.getCoverImageId(libraryItem.id, this.getItemVersion(libraryItem)) })
            }
          } catch (error) {
            Logger.warn(`[KoboSyncManager] Sending a bare removal for ${row.libraryItemId}: ${error.message}`)
          }
        }
        results.push({ ChangedEntitlement: entitlement })
        addPending(row.libraryItemId, row.deliveredVersion, row.deliveredFormat, true)
      }
    }
    await Database.koboSyncedItemModel.bulkCreate(pendingRows, { updateOnDuplicate: ['pendingCheckpoint', 'pendingVersion', 'pendingFormat', 'pendingRemoved', 'removedBy'] })

    // Reading states changed since the last sync, for books the device holds
    const heldItems = [...scope.items.values()].filter((item) => {
      const row = rowsById.get(item.id)
      return (row?.deliveredAt && !row.isRemoved) || entitledIds.has(item.id)
    })
    const readingStates = await KoboReadingStateManager.getChangedReadingStates(user, heldItems, token.readingStateLastModified, entitledIds, SYNC_ITEM_LIMIT)
    for (const state of readingStates.states) {
      results.push({ ChangedReadingState: { ReadingState: state } })
    }
    if (readingStates.hasMore) hasMore = true
    token.readingStateLastModified = Math.max(token.readingStateLastModified, readingStates.lastModified)

    // Collections, not paginated (Calibre-Web behavior)
    results.push(...(await this.getTagChanges(device, scope, checkpoint)))

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

    await device.update({ lastSyncAt: new Date() })
    Logger.info(`[KoboSyncManager] Sync for "${user.username}" device "${device.name}": ${entitledIds.size} books, ${pageRemovals.length} removals, ${readingStates.states.length} reading states${hasMore ? ', more to come' : ''}`)
    return { results, token, headers }
  }

  /**
   * What this device is missing: new or changed items in order of change, then removals
   *
   * @param {Scope} scope
   * @param {Map<string, import('../models/KoboSyncedItem')>} rowsById
   * @returns {{ changes: { item: ScopeItem, isNew: boolean }[], removals: import('../models/KoboSyncedItem')[] }}
   */
  getPendingChanges(scope, rowsById) {
    const changes = []
    for (const item of scope.items.values()) {
      const row = rowsById.get(item.id)
      if (!row || !row.deliveredAt) {
        changes.push({ item, isNew: true })
      } else if (row.isRemoved) {
        // Deleted on the Kobo: stays off this device until a resync.
        // Left the scope and came back: the device no longer has it, so it is new again.
        if (row.removedBy !== 'device') changes.push({ item, isNew: true })
      } else if (item.version > Number(row.deliveredVersion || 0) || item.format !== row.deliveredFormat) {
        changes.push({ item, isNew: false })
      }
    }
    changes.sort((a, b) => a.item.version - b.item.version || a.item.id.localeCompare(b.item.id))

    const removals = []
    for (const row of rowsById.values()) {
      if (!row.deliveredAt || row.isRemoved || scope.items.has(row.libraryItemId) || scope.missingIds.has(row.libraryItemId)) continue
      removals.push(row)
    }
    removals.sort((a, b) => a.libraryItemId.localeCompare(b.libraryItemId))
    return { changes, removals }
  }

  /**
   * NewTag, ChangedTag and DeletedTag for the collections this device syncs
   *
   * @param {import('../models/KoboDevice')} device
   * @param {Scope} scope
   * @param {string} checkpoint
   * @returns {Promise<Object[]>}
   */
  async getTagChanges(device, scope, checkpoint) {
    const where = { libraryId: scope.libraryIds }
    if (device.onlyCollections) where.id = device.collectionIds || []
    const collections = await Database.collectionModel.findAll({ where, order: [['createdAt', 'ASC']] })

    const mediaIdToItemId = new Map([...scope.items.values()].map((item) => [item.mediaId, item.id]))
    const collectionBooks = await Database.collectionBookModel.findAll({ attributes: ['collectionId', 'bookId'], where: { collectionId: collections.map((collection) => collection.id) }, order: [['order', 'ASC']] })
    /** @type {Map<string, string[]>} collectionId -> library item ids */
    const itemIdsByCollection = new Map(collections.map((collection) => [collection.id, []]))
    for (const collectionBook of collectionBooks) {
      const itemId = mediaIdToItemId.get(collectionBook.bookId)
      if (itemId) itemIdsByCollection.get(collectionBook.collectionId).push(itemId)
    }

    const rows = await Database.koboSyncedCollectionModel.findAll({ where: { koboDeviceId: device.id } })
    const rowsById = new Map(rows.map((row) => [row.collectionId, row]))
    const results = []
    const pendingRows = []
    const addPending = (collectionId, hash, deleted) => pendingRows.push({ koboDeviceId: device.id, collectionId, pendingCheckpoint: checkpoint, pendingHash: hash, pendingDeleted: deleted })

    for (const collection of collections) {
      const itemIds = itemIdsByCollection.get(collection.id)
      const hash = crypto.createHash('sha1').update(JSON.stringify([collection.name, itemIds])).digest('hex')
      const row = rowsById.get(collection.id)
      const isNew = !row?.deliveredHash || row.isDeleted
      if (!isNew && row.deliveredHash === hash) continue
      results.push({ [isNew ? 'NewTag' : 'ChangedTag']: buildTag(collection, itemIds) })
      addPending(collection.id, hash, false)
    }

    for (const row of rows) {
      if (itemIdsByCollection.has(row.collectionId) || row.isDeleted || !row.deliveredHash) continue
      results.push({ DeletedTag: buildDeletedTag(row.collectionId) })
      addPending(row.collectionId, row.deliveredHash, true)
    }
    await Database.koboSyncedCollectionModel.bulkCreate(pendingRows, { updateOnDuplicate: ['pendingCheckpoint', 'pendingHash', 'pendingDeleted'] })
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
   * The device deleted a book: keep it off this device until a resync
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
}

module.exports = new KoboSyncManager()
