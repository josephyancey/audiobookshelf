const crypto = require('crypto')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const RssFeedManager = require('./RssFeedManager')
const htmlSanitizer = require('../utils/htmlSanitizer')

/**
 * Collection edits made on a Kobo: applied to the ABS collection when the user has permission,
 * otherwise accepted and ignored so the device does not retry or abort. Creating, renaming and
 * adding/removing books need update permission; deleting needs delete permission. Socket events
 * match CollectionController so open web clients refresh.
 */
class KoboCollectionManager {
  constructor() {}

  /**
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {'canUpdate'|'canDelete'} permission
   * @param {string} edit for the log
   * @returns {boolean}
   */
  isAllowed(user, device, permission, edit) {
    if (!user[permission]) Logger.info(`[KoboCollectionManager] Ignoring ${edit} from Kobo "${device.name}": "${user.username}" lacks the permission`)
    return !!user[permission]
  }

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
    return collection && user.checkCanAccessLibrary(collection.libraryId) ? collection : null
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
   * POST /v1/library/tags. A collection belongs to one library: that of its first book, else
   * the first library the device syncs.
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {{ Name?: string, Items?: Object[] }} body
   * @returns {Promise<string>} id the device should use for the new collection
   */
  async createFromDevice(user, device, body) {
    const name = htmlSanitizer.stripAllTags(body.Name || '').trim()
    if (!name || !this.isAllowed(user, device, 'canUpdate', `new collection "${name}"`)) return crypto.randomUUID()

    const libraryItems = await this.getLibraryItems(user, body.Items)
    let libraryId = libraryItems[0]?.libraryId
    if (!libraryId) {
      const libraries = await Database.libraryModel.findAll({ attributes: ['id'], where: { mediaType: 'book' }, order: [['displayOrder', 'ASC']] })
      libraryId = device.getLibraryIdsToSync(user, libraries.map((library) => library.id))[0]
    }
    if (!libraryId) return crypto.randomUUID()

    const books = libraryItems.filter((libraryItem) => libraryItem.libraryId === libraryId)
    const collection = await Database.sequelize.transaction(async (transaction) => {
      const newCollection = await Database.collectionModel.create({ libraryId, name }, { transaction })
      const collectionBooks = books.map((libraryItem, index) => ({ collectionId: newCollection.id, bookId: libraryItem.mediaId, order: index + 1 }))
      await Database.collectionBookModel.bulkCreate(collectionBooks, { transaction })
      return newCollection
    })
    Logger.info(`[KoboCollectionManager] Kobo "${device.name}" created collection "${name}" with ${books.length} books`)
    await this.emit(collection, user, 'collection_added')
    return collection.id
  }

  /**
   * PUT /v1/library/tags/<id>
   *
   * @param {import('../models/User')} user
   * @param {import('../models/KoboDevice')} device
   * @param {import('../models/Collection')} collection
   * @param {{ Name?: string }} body
   */
  async renameFromDevice(user, device, collection, body) {
    const name = htmlSanitizer.stripAllTags(body.Name || '').trim()
    if (!name || name === collection.name || !this.isAllowed(user, device, 'canUpdate', `rename of "${collection.name}"`)) return
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
    if (!this.isAllowed(user, device, 'canDelete', `delete of "${collection.name}"`)) return
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
   * @param {import('../models/KoboDevice')} device
   * @param {import('../models/Collection')} collection
   * @param {Object[]} items
   * @param {boolean} remove
   */
  async updateItemsFromDevice(user, device, collection, items, remove) {
    if (!this.isAllowed(user, device, 'canUpdate', `book changes to "${collection.name}"`)) return
    const libraryItems = await this.getLibraryItems(user, items)
    const mediaIds = new Set(libraryItems.filter((libraryItem) => libraryItem.libraryId === collection.libraryId).map((libraryItem) => libraryItem.mediaId))
    if (!mediaIds.size) return

    const collectionBooks = await collection.getCollectionBooks({ order: [['order', 'ASC']] })
    await Database.sequelize.transaction(async (transaction) => {
      if (remove) {
        await Database.collectionBookModel.destroy({ where: { collectionId: collection.id, bookId: [...mediaIds] }, transaction })
        const kept = collectionBooks.filter((collectionBook) => !mediaIds.has(collectionBook.bookId))
        for (const [index, collectionBook] of kept.entries()) {
          if (collectionBook.order !== index + 1) await collectionBook.update({ order: index + 1 }, { transaction })
        }
      } else {
        const existing = new Set(collectionBooks.map((collectionBook) => collectionBook.bookId))
        const added = [...mediaIds].filter((mediaId) => !existing.has(mediaId))
        const newBooks = added.map((bookId, index) => ({ collectionId: collection.id, bookId, order: collectionBooks.length + index + 1 }))
        await Database.collectionBookModel.bulkCreate(newBooks, { transaction })
      }
    })
    await this.emit(collection, user, 'collection_updated')
  }
}

module.exports = new KoboCollectionManager()
