const { Op } = require('sequelize')
const { LRUCache } = require('lru-cache')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const KepubManager = require('./KepubManager')
const { buildBookMap, locateBookmark, bookmarkFromProgress } = require('../utils/kobo/kepubPosition')
const { koboTimestamp } = require('../utils/kobo/koboJson')

/**
 * Reading progress between a Kobo and Audiobookshelf media progress (docs/kobo-sync/design.md §7).
 *
 * Device → ABS: the Kobo's bookmark (a KoboSpan in the kepub it holds) becomes an exact
 * ebookProgress plus an epub CFI, through the same media progress update the web reader uses,
 * so the web UI, the apps and BookBridge all see it.
 *
 * ABS → device: while ABS progress is still the one the device sent, the device's own state is
 * returned verbatim (same numbers, same timestamps). Anything else makes a Kobo ask "Return to
 * last page read?" (Calibre-Web d229f711, open PR #3607). When ABS progress moved elsewhere, a
 * new bookmark is built: CFI → character → the KoboSpan at or before it.
 */
class KoboReadingStateManager {
  constructor() {
    /** @type {LRUCache<string, Promise<Object|null>>} ebook path + mtime → book map */
    this.bookMaps = new LRUCache({ max: 16 })
  }

  /**
   * @param {string} path
   * @param {number|string} [mtime]
   * @returns {Promise<Object|null>}
   */
  getBookMap(path, mtime) {
    if (!path) return Promise.resolve(null)
    const key = `${path}:${mtime || ''}`
    let pending = this.bookMaps.get(key)
    if (!pending) {
      pending = buildBookMap(path).catch((error) => {
        Logger.warn(`[KoboReadingStateManager] Could not read "${path}": ${error.message}`)
        this.bookMaps.delete(key)
        return null
      })
      this.bookMaps.set(key, pending)
    }
    return pending
  }

  /**
   * The maps a position is converted with: the file the device reads (the kepub when there is
   * one, so KoboSpans resolve) and the original epub that ABS's own reader addresses with CFIs.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<{ deviceMap: Object|null, cfiBookMap: Object|null }>}
   */
  async getMaps(libraryItem) {
    const ebookFile = libraryItem.media?.ebookFile
    if (!ebookFile?.metadata?.path) return { deviceMap: null, cfiBookMap: null }
    const epubMap = await this.getBookMap(ebookFile.metadata.path, ebookFile.metadata.mtimeMs)
    let kepubPath = null
    try {
      kepubPath = await KepubManager.getCachedKepubPath(libraryItem)
    } catch (error) {
      Logger.debug(`[KoboReadingStateManager] No kepub for ${libraryItem.id}: ${error.message}`)
    }
    if (!kepubPath || kepubPath === ebookFile.metadata.path) {
      return { deviceMap: epubMap, cfiBookMap: null }
    }
    const kepubMap = await this.getBookMap(kepubPath)
    return { deviceMap: kepubMap || epubMap, cfiBookMap: kepubMap ? epubMap : null }
  }

  /**
   * @param {string} userId
   * @param {string} bookId
   * @returns {Promise<import('../models/MediaProgress')|null>}
   */
  getMediaProgress(userId, bookId) {
    return Database.mediaProgressModel.findOne({ where: { userId, mediaItemId: bookId } })
  }

  /**
   * @param {import('../models/MediaProgress')|null} mediaProgress
   * @returns {'ReadyToRead'|'Reading'|'Finished'}
   */
  getStatus(mediaProgress) {
    if (mediaProgress?.isFinished) return 'Finished'
    if (mediaProgress && (mediaProgress.ebookProgress > 0 || mediaProgress.ebookLocation)) return 'Reading'
    return 'ReadyToRead'
  }

  /**
   * The ReadingState for one book, or null when there is nothing to report
   *
   * @param {import('../models/User')} user
   * @param {import('../models/LibraryItem')} libraryItem with media (book)
   * @returns {Promise<Object|null>}
   */
  async getReadingState(user, libraryItem) {
    const [mediaProgress, stored] = await Promise.all([this.getMediaProgress(user.id, libraryItem.media.id), Database.koboReadingStateModel.getForUserItem(user.id, libraryItem.id)])
    if (!mediaProgress && !stored?.currentBookmark) return null

    const created = koboTimestamp(libraryItem.addedAt || libraryItem.createdAt)
    if (stored?.lastModified && stored.progressUpdatedAt && (!mediaProgress || mediaProgress.updatedAt.valueOf() <= stored.progressUpdatedAt.valueOf())) {
      // ABS progress is still what the device sent: hand its own state back unchanged
      const state = {
        EntitlementId: libraryItem.id,
        Created: created,
        LastModified: stored.lastModified,
        PriorityTimestamp: stored.priorityTimestamp || stored.lastModified
      }
      if (stored.statusInfo) state.StatusInfo = stored.statusInfo
      if (stored.statistics) state.Statistics = stored.statistics
      if (stored.currentBookmark) state.CurrentBookmark = stored.currentBookmark
      return state
    }
    if (!mediaProgress) return null

    const lastModified = koboTimestamp(mediaProgress.updatedAt)
    const status = this.getStatus(mediaProgress)
    const timesStarted = Number(stored?.statusInfo?.TimesStartedReading) || (status === 'ReadyToRead' ? 0 : 1)
    const state = {
      EntitlementId: libraryItem.id,
      Created: created,
      LastModified: lastModified,
      PriorityTimestamp: lastModified,
      StatusInfo: {
        LastModified: lastModified,
        Status: status,
        TimesStartedReading: timesStarted
      },
      Statistics: stored?.statistics || { LastModified: lastModified },
      CurrentBookmark: { LastModified: lastModified }
    }
    if (stored?.statusInfo?.LastTimeStartedReading) state.StatusInfo.LastTimeStartedReading = stored.statusInfo.LastTimeStartedReading

    if (mediaProgress.isFinished) {
      state.CurrentBookmark.ProgressPercent = 100
    } else if (mediaProgress.ebookLocation || mediaProgress.ebookProgress > 0) {
      const { deviceMap, cfiBookMap } = await this.getMaps(libraryItem)
      const bookmark = deviceMap ? bookmarkFromProgress(deviceMap, { ebookLocation: mediaProgress.ebookLocation, ebookProgress: mediaProgress.ebookProgress }, { cfiBookMap }) : null
      if (bookmark) {
        Object.assign(state.CurrentBookmark, bookmark)
      } else {
        state.CurrentBookmark.ProgressPercent = Math.round((Number(mediaProgress.ebookProgress) || 0) * 100)
      }
    }
    return state
  }

  /**
   * Reading states that changed since the device's last sync, oldest change first
   *
   * @param {import('../models/User')} user
   * @param {string[]} libraryItemIds books the device holds
   * @param {number} sinceMs
   * @param {Set<string>} excludeIds already sent inside an entitlement on this page
   * @param {number} limit
   * @returns {Promise<{ states: Object[], hasMore: boolean, lastModified: number }>}
   */
  async getChangedReadingStates(user, libraryItemIds, sinceMs, excludeIds, limit) {
    const result = { states: [], hasMore: false, lastModified: 0 }
    if (!libraryItemIds.length) return result
    const since = new Date(sinceMs || 0)

    const items = await Database.libraryItemModel.findAll({
      attributes: ['id', 'mediaId', 'mediaType', 'libraryId', 'createdAt', 'updatedAt'],
      where: { id: libraryItemIds },
      include: { model: Database.bookModel, attributes: ['id', 'ebookFile', 'updatedAt'] }
    })
    const itemByMediaId = new Map(items.map((item) => [item.mediaId, item]))
    const itemById = new Map(items.map((item) => [item.id, item]))

    /** @type {Map<string, number>} libraryItemId → modified ms */
    const modified = new Map()
    const progresses = await Database.mediaProgressModel.findAll({
      attributes: ['mediaItemId', 'updatedAt'],
      where: { userId: user.id, mediaItemId: [...itemByMediaId.keys()], updatedAt: { [Op.gt]: since } }
    })
    for (const progress of progresses) {
      const item = itemByMediaId.get(progress.mediaItemId)
      if (item) modified.set(item.id, progress.updatedAt.valueOf())
    }
    const storedStates = await Database.koboReadingStateModel.findAll({
      attributes: ['libraryItemId', 'updatedAt'],
      where: { userId: user.id, libraryItemId: libraryItemIds, updatedAt: { [Op.gt]: since } }
    })
    for (const stored of storedStates) {
      modified.set(stored.libraryItemId, Math.max(modified.get(stored.libraryItemId) || 0, stored.updatedAt.valueOf()))
    }

    const ordered = [...modified.entries()].filter(([id]) => !excludeIds.has(id)).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    result.hasMore = ordered.length > limit
    for (const [id, modifiedMs] of ordered.slice(0, limit)) {
      const libraryItem = itemById.get(id)
      try {
        const state = await this.getReadingState(user, libraryItem)
        if (state) result.states.push(state)
      } catch (error) {
        Logger.error(`[KoboReadingStateManager] Skipping reading state for ${id}: ${error.message}`)
      }
      result.lastModified = Math.max(result.lastModified, modifiedMs)
    }
    for (const id of excludeIds) {
      const modifiedMs = modified.get(id)
      if (modifiedMs) result.lastModified = Math.max(result.lastModified, modifiedMs)
    }
    return result
  }

  /**
   * PUT /v1/library/<id>/state from the device. Every key is optional (Calibre-Web lesson 11).
   *
   * @param {import('../models/User')} user
   * @param {import('../models/LibraryItem')} libraryItem expanded
   * @param {Object} incoming one element of ReadingStates
   * @returns {Promise<{ error?: string, statusCode?: number }>}
   */
  async applyDeviceState(user, libraryItem, incoming) {
    const stored = await Database.koboReadingStateModel.getForUserItem(user.id, libraryItem.id)
    const previousStatus = stored?.statusInfo?.Status || null
    const values = {
      lastModified: typeof incoming.LastModified === 'string' ? incoming.LastModified : stored?.lastModified || koboTimestamp(Date.now()),
      priorityTimestamp: typeof incoming.PriorityTimestamp === 'string' ? incoming.PriorityTimestamp : stored?.priorityTimestamp || null
    }
    if (incoming.CurrentBookmark && typeof incoming.CurrentBookmark === 'object') values.currentBookmark = incoming.CurrentBookmark
    if (incoming.StatusInfo && typeof incoming.StatusInfo === 'object') values.statusInfo = incoming.StatusInfo
    if (incoming.Statistics && typeof incoming.Statistics === 'object') values.statistics = incoming.Statistics

    const payload = { libraryItemId: libraryItem.id }
    const status = values.statusInfo?.Status
    if (status === 'Finished') {
      payload.isFinished = true
    } else if ((status === 'Reading' || status === 'ReadyToRead') && previousStatus === 'Finished') {
      // Only the device itself reopening a book it finished unfinishes it. ABS unfinishing an
      // item resets the audiobook position, so a device that simply never knew is ignored.
      payload.isFinished = false
    }

    if (values.currentBookmark && status !== 'Finished') {
      const { deviceMap, cfiBookMap } = await this.getMaps(libraryItem)
      const spot = locateBookmark(deviceMap, values.currentBookmark, { cfiBookMap })
      if (spot) {
        payload.ebookProgress = spot.progress
        if (spot.cfi) payload.ebookLocation = spot.cfi
        Logger.debug(`[KoboReadingStateManager] "${libraryItem.media.title}" at ${(spot.progress * 100).toFixed(4)}% (${spot.method})`)
      }
    } else if (status === 'Finished') {
      payload.ebookProgress = 1
    }

    if (Object.keys(payload).length > 1) {
      const response = await user.createUpdateMediaProgressFromPayload(payload)
      if (response.error) return { error: response.error, statusCode: response.statusCode }
      values.progressUpdatedAt = response.mediaProgress.updatedAt
      SocketAuthority.clientEmitter(user.id, 'user_updated', user.toOldJSONForBrowser())
    } else {
      const mediaProgress = await this.getMediaProgress(user.id, libraryItem.media.id)
      values.progressUpdatedAt = mediaProgress?.updatedAt || new Date()
    }

    if (stored) await stored.update(values)
    else await Database.koboReadingStateModel.create({ userId: user.id, libraryItemId: libraryItem.id, ...values })
    return {}
  }

  /**
   * A kepub just became available for a book: send the reading state again on the next sync so
   * the device gets a KoboSpan bookmark instead of a bare percentage.
   *
   * @param {import('../models/User')} user
   * @param {import('../models/LibraryItem')} libraryItem
   */
  async touchAfterDownload(user, libraryItem) {
    const mediaProgress = await this.getMediaProgress(user.id, libraryItem.media.id)
    if (!mediaProgress || (!mediaProgress.ebookLocation && !(mediaProgress.ebookProgress > 0))) return
    const stored = await Database.koboReadingStateModel.getForUserItem(user.id, libraryItem.id)
    if (stored) {
      if (stored.progressUpdatedAt && stored.progressUpdatedAt.valueOf() >= mediaProgress.updatedAt.valueOf()) return
      stored.changed('updatedAt', true)
      await stored.save()
    } else {
      await Database.koboReadingStateModel.create({ userId: user.id, libraryItemId: libraryItem.id })
    }
  }
}

module.exports = new KoboReadingStateManager()
