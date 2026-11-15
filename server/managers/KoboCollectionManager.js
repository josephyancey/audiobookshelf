const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const RssFeedManager = require('./RssFeedManager')
const htmlSanitizer = require('../utils/htmlSanitizer')

/**
 * Collection edits made on a Kobo (design §12.1): applied to the ABS collection when the user
 * has permission, otherwise accepted and ignored so the device does not retry or abort.
 * Creating, renaming and adding/removing books need update permission; deleting needs delete
 * permission. Socket events match CollectionController so open web clients refresh.
 */
class KoboCollectionManager {
  constructor() {}

  /**
   * @param {import('../models/Collection')} collection
   * @param {import('../models/User')} user
   * @param {string} event
   */
  async emit(collection, user, event) {
    // A failed notification must not fail the device's request
    try {
      const jsonExpanded = await collection.getOldJsonExpanded(user)
      if (jsonExpanded) SocketAuthority.clientEmitter(user.id, event, jsonExpanded)
    } catch (error) {
      Logger.error(`[KoboCollectionManager] Failed to notify clients of ${event}`, error)
    }
  }

  /**
   * @param {import('../models/User')} user
   * @param {string} collectionId
   * @returns {Promise<import('../models/Collection')|null>}
   */
  async getCollection(user, collectionId) {
    const collection = await Database.collectionModel.findByPk(collectionId)
    if (!collection || !user.checkCanAccessLibrary(collection.libraryId)) return null
    return collection
  }

  /**
   * Library items from a Kobo `Items` list, limited to books the user can access
   *
   * @param {import('../models/User')} user
   * @param {Object[]} items
   * @returns {Promise<import('../models/LibraryItem')[]>}
   */
  async getLibraryItems(user, items) {
    const ids = (Array.isArray(items) ? items : []).map((item) => item?.RevisionId).filter((id) => typeof id === 'string')
    if (!ids.length) return []
    const libraryItems = await Database.libraryItemModel.findAll({
      attributes: ['id', 'libraryId', 'mediaId', 'mediaType'],
      where: { id: ids, mediaType: 'book' },
      include: { model: Database.bookModel, attributes: ['id', 'explicit', 'tags'] }
    })
    return libraryItems.filter((libraryItem) => user.checkCanAccessLibraryItem(libraryItem))
  }

  /**
   * POST /v1/library/tags
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {{ Name?: string, Items?: Object[] }} body
   * @returns {Promise<string>} id the device should use for the new collection
   */
  async createFromDevice(user, device, body) {
    const name = htmlSanitizer.stripAllTags(body?.Name || '').trim()
    if (!user.canUpdate || !name) {
      Logger.info(`[KoboCollectionManager] Ignoring collection "${name}" created on Kobo "${device.name}" by "${user.username}" (no update permission or no name)`)
      return require('crypto').randomUUID()
    }
    const libraryItems = await this.getLibraryItems(user, body.Items)
    let libraryId = libraryItems[0]?.libraryId
    if (!libraryId) {
      const libraries = await Database.libraryModel.findAll({ attributes: ['id', 'mediaType', 'displayOrder'], order: [['displayOrder', 'ASC']] })
      libraryId = device.getLibraryIdsToSync(
        user,
        libraries.filter((library) => library.mediaType === 'book').map((library) => library.id)
      )[0]
    }
    if (!libraryId) return require('crypto').randomUUID()

    const collection = await Database.collectionModel.create({ libraryId, name, description: null })
    let order = 1
    for (const libraryItem of libraryItems.filter((item) => item.libraryId === libraryId)) {
      await Database.collectionBookModel.create({ collectionId: collection.id, bookId: libraryItem.mediaId, order: order++ })
    }
    Logger.info(`[KoboCollectionManager] Kobo "${device.name}" created collection "${name}" with ${order - 1} books`)
    await this.emit(collection, user, 'collection_added')
    return collection.id
  }

  /**
   * PUT /v1/library/tags/<id>
   *
   * @param {import('../models/User')} user
   * @param {import('../models/Collection')} collection
   * @param {{ Name?: string }} body
   */
  async renameFromDevice(user, collection, body) {
    const name = htmlSanitizer.stripAllTags(body?.Name || '').trim()
    if (!user.canUpdate || !name || name === collection.name) {
      if (name && name !== collection.name) Logger.info(`[KoboCollectionManager] Ignoring rename of "${collection.name}" from Kobo: "${user.username}" has no update permission`)
      return
    }
    await collection.update({ name })
    await this.emit(collection, user, 'collection_updated')
  }

  /**
   * DELETE /v1/library/tags/<id>
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {import('../models/Collection')} collection
   */
  async deleteFromDevice(user, device, collection) {
    if (!user.canDelete) {
      Logger.info(`[KoboCollectionManager] Ignoring delete of collection "${collection.name}" from Kobo: "${user.username}" has no delete permission`)
      return
    }
    const jsonExpanded = await collection.getOldJsonExpanded(user)
    await RssFeedManager.closeFeedForEntityId(collection.id)
    await collection.destroy()
    if (jsonExpanded) SocketAuthority.clientEmitter(user.id, 'collection_removed', jsonExpanded)
    // The device already removed it; don't send it a DeletedTag again
    await Database.koboSyncedCollectionModel.update({ isDeleted: true, pendingCheckpoint: null }, { where: { koboDeviceId: device.id, collectionId: collection.id } })
    Logger.info(`[KoboCollectionManager] Kobo "${device.name}" deleted collection "${collection.name}"`)
  }

  /**
   * POST /v1/library/tags/<id>/items and .../items/delete
   *
   * @param {import('../models/User')} user
   * @param {import('../models/Collection')} collection
   * @param {Object[]} items
   * @param {boolean} remove
   */
  async updateItemsFromDevice(user, collection, items, remove) {
    if (!user.canUpdate) {
      Logger.info(`[KoboCollectionManager] Ignoring book changes to "${collection.name}" from Kobo: "${user.username}" has no update permission`)
      return
    }
    const libraryItems = (await this.getLibraryItems(user, items)).filter((libraryItem) => libraryItem.libraryId === collection.libraryId)
    if (!libraryItems.length) return
    const mediaIds = new Set(libraryItems.map((libraryItem) => libraryItem.mediaId))
    const collectionBooks = await collection.getCollectionBooks({ order: [['order', 'ASC']] })

    if (remove) {
      let order = 1
      for (const collectionBook of collectionBooks) {
        if (mediaIds.has(collectionBook.bookId)) {
          await collectionBook.destroy()
        } else {
          if (collectionBook.order !== order) await collectionBook.update({ order })
          order++
        }
      }
    } else {
      const existing = new Set(collectionBooks.map((collectionBook) => collectionBook.bookId))
      let order = collectionBooks.length + 1
      for (const mediaId of mediaIds) {
        if (existing.has(mediaId)) continue
        await Database.collectionBookModel.create({ collectionId: collection.id, bookId: mediaId, order: order++ })
      }
    }
    await this.emit(collection, user, 'collection_updated')
  }
}

module.exports = new KoboCollectionManager()
