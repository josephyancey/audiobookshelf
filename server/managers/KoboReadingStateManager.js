const { Op } = require('sequelize')
const { LRUCache } = require('lru-cache')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const KepubManager = require('./KepubManager')
const { buildBookMap, locateBookmark, bookmarkFromProgress } = require('../utils/kobo/kepubPosition')
const { koboTimestamp } = require('../utils/kobo/koboJson')

/**
 * @typedef ProgressAndState
 * @property {import('../models/MediaProgress')|null} mediaProgress
 * @property {import('../models/KoboReadingState')|null} stored
 */

/**
 * Reading progress between a Kobo and Audiobookshelf media progress.
 *
 * Device → ABS: the Kobo's bookmark (a KoboSpan in the kepub it holds) becomes an exact
 * ebookProgress plus an epub CFI, through the same media progress update the web reader uses,
 * so the web UI, the apps and BookBridge all see it.
 *
 * ABS → device: the last Kobo state is kept with a snapshot of the ebook progress it stands for.
 * While ABS ebook progress still matches that snapshot the state is returned verbatim (same
 * numbers, same timestamps); anything else makes a Kobo ask "Return to last page read?"
 * (Calibre-Web d229f711, open PR #3607). When the ebook position moved elsewhere, a new bookmark
 * is built (CFI → character → the KoboSpan at or before it) and stored the same way.
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
    const key = `${path}:${mtime || ''}`
    if (!this.bookMaps.has(key)) {
      const pending = buildBookMap(path).catch((error) => {
        Logger.warn(`[KoboReadingStateManager] Could not read "${path}": ${error.message}`)
        this.bookMaps.delete(key)
        return null
      })
      this.bookMaps.set(key, pending)
    }
    return this.bookMaps.get(key)
  }

  /**
   * The maps a position is converted with: the file the device reads (the kepub when there is
   * one, so KoboSpans resolve) and the original epub that ABS's own reader addresses with CFIs.
   * Sync only uses a cached kepub; a KoboSpan from the device may convert one (kepubify output
   * is deterministic, so the spans match the kepub the device holds).
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {boolean} [convert] convert the kepub when it is not cached
   * @returns {Promise<{ deviceMap: Object|null, cfiBookMap: Object|null }>}
   */
  async getMaps(libraryItem, convert = false) {
    const ebookFile = libraryItem.media.ebookFile
    const epubMap = await this.getBookMap(ebookFile.metadata.path, ebookFile.metadata.mtimeMs)
    const kepubPath = convert ? await KepubManager.getKepubPath(libraryItem) : await KepubManager.getCachedKepubPath(libraryItem)
    if (!kepubPath || kepubPath === ebookFile.metadata.path) {
      return { deviceMap: epubMap, cfiBookMap: null }
    }
    const kepubMap = await this.getBookMap(kepubPath)
    return { deviceMap: kepubMap || epubMap, cfiBookMap: kepubMap ? epubMap : null }
  }

  /**
   * The ebook part of a media progress. Audio playback changes updatedAt all the time, so this,
   * not a timestamp, tells whether the ebook position moved.
   *
   * @param {import('../models/MediaProgress')|null} mediaProgress
   * @returns {string}
   */
  getSnapshot(mediaProgress) {
    return JSON.stringify([mediaProgress?.ebookLocation || null, mediaProgress?.ebookProgress || 0, !!mediaProgress?.isFinished])
  }

  /**
   * Media progress and stored Kobo state of several books, in one query each
   *
   * @param {string} userId
   * @param {{ id: string, mediaId: string }[]} libraryItems
   * @returns {Promise<Map<string, ProgressAndState>>} by libraryItemId
   */
  async getProgressAndStates(userId, libraryItems) {
    const [progresses, states] = await Promise.all([
      Database.mediaProgressModel.findAll({ where: { userId, mediaItemId: libraryItems.map((libraryItem) => libraryItem.mediaId) } }),
      Database.koboReadingStateModel.findAll({ where: { userId, libraryItemId: libraryItems.map((libraryItem) => libraryItem.id) } })
    ])
    const progressByMediaId = new Map(progresses.map((mediaProgress) => [mediaProgress.mediaItemId, mediaProgress]))
    const stateByItemId = new Map(states.map((stored) => [stored.libraryItemId, stored]))
    return new Map(libraryItems.map((libraryItem) => [libraryItem.id, { mediaProgress: progressByMediaId.get(libraryItem.mediaId) || null, stored: stateByItemId.get(libraryItem.id) || null }]))
  }

  /**
   * @param {import('../models/MediaProgress')|null} mediaProgress
   * @returns {'ReadyToRead'|'Reading'|'Finished'}
   */
  getStatus(mediaProgress) {
    if (mediaProgress?.isFinished) return 'Finished'
    if (mediaProgress?.ebookProgress > 0 || mediaProgress?.ebookLocation) return 'Reading'
    return 'ReadyToRead'
  }

  /**
   * The ReadingState for one book, or null when there is nothing to report
   *
   * @param {import('../models/User')} user
   * @param {import('../models/LibraryItem')} libraryItem with media (book)
   * @param {ProgressAndState} [progressAndState] already loaded
   * @returns {Promise<Object|null>}
   */
  async getReadingState(user, libraryItem, progressAndState = null) {
    const { mediaProgress, stored } = progressAndState || (await this.getProgressAndStates(user.id, [libraryItem])).get(libraryItem.id)
    const snapshot = this.getSnapshot(mediaProgress)
    const created = koboTimestamp(libraryItem.createdAt)

    if (stored?.lastModified && stored.snapshot === snapshot) {
      const state = { EntitlementId: libraryItem.id, Created: created, LastModified: stored.lastModified, PriorityTimestamp: stored.priorityTimestamp || stored.lastModified }
      if (stored.statusInfo) state.StatusInfo = stored.statusInfo
      if (stored.statistics) state.Statistics = stored.statistics
      if (stored.currentBookmark) state.CurrentBookmark = stored.currentBookmark
      return state
    }
    if (!mediaProgress) return null

    const lastModified = koboTimestamp(mediaProgress.updatedAt)
    const status = this.getStatus(mediaProgress)
    const statusInfo = { LastModified: lastModified, Status: status, TimesStartedReading: Number(stored?.statusInfo?.TimesStartedReading) || (status === 'ReadyToRead' ? 0 : 1) }
    if (stored?.statusInfo?.LastTimeStartedReading) statusInfo.LastTimeStartedReading = stored.statusInfo.LastTimeStartedReading
    const bookmark = { LastModified: lastModified }
    if (mediaProgress.isFinished) {
      bookmark.ProgressPercent = 100
    } else if (status === 'Reading') {
      const { deviceMap, cfiBookMap } = await this.getMaps(libraryItem)
      const position = deviceMap ? bookmarkFromProgress(deviceMap, mediaProgress, { cfiBookMap }) : null
      Object.assign(bookmark, position || { ProgressPercent: Math.round((mediaProgress.ebookProgress || 0) * 100) })
    }
    const state = {
      EntitlementId: libraryItem.id,
      Created: created,
      LastModified: lastModified,
      PriorityTimestamp: lastModified,
      StatusInfo: statusInfo,
      Statistics: stored?.statistics || { LastModified: lastModified },
      CurrentBookmark: bookmark
    }

    // Kept as the Kobo state of this progress, so it is returned verbatim from now on. Silent (or
    // dated like the progress) so that storing it does not count as a change for the next sync.
    const values = { currentBookmark: bookmark, statusInfo, statistics: state.Statistics, lastModified, priorityTimestamp: lastModified, snapshot }
    await this.saveState(user.id, libraryItem.id, { ...values, updatedAt: stored?.updatedAt || mediaProgress.updatedAt })
    return state
  }

  /**
   * Reading states that changed since the device's last sync, oldest change first
   *
   * @param {import('../models/User')} user
   * @param {{ id: string, mediaId: string, libraryItem: import('../models/LibraryItem') }[]} heldItems books the device holds
   * @param {number} sinceMs
   * @param {Set<string>} excludeIds already sent inside an entitlement on this page
   * @param {number} limit
   * @returns {Promise<{ states: Object[], hasMore: boolean, lastModified: number }>}
   */
  async getChangedReadingStates(user, heldItems, sinceMs, excludeIds, limit) {
    const result = { states: [], hasMore: false, lastModified: 0 }
    const since = new Date(sinceMs || 0)
    const heldById = new Map(heldItems.map((item) => [item.id, item]))
    const heldByMediaId = new Map(heldItems.map((item) => [item.mediaId, item]))

    // >= keeps changes that share the cursor's millisecond; ones already sent are skipped below
    const where = { userId: user.id, updatedAt: { [Op.gte]: since } }
    const [progresses, storedStates] = await Promise.all([Database.mediaProgressModel.findAll({ attributes: ['mediaItemId', 'updatedAt'], where }), Database.koboReadingStateModel.findAll({ attributes: ['libraryItemId', 'updatedAt'], where })])
    /** @type {Map<string, number>} libraryItemId → latest change, epoch ms */
    const changed = new Map()
    const addChange = (item, date) => {
      if (item) changed.set(item.id, Math.max(changed.get(item.id) || 0, date.valueOf()))
    }
    progresses.forEach((mediaProgress) => addChange(heldByMediaId.get(mediaProgress.mediaItemId), mediaProgress.updatedAt))
    storedStates.forEach((stored) => addChange(heldById.get(stored.libraryItemId), stored.updatedAt))

    const ordered = [...changed].filter(([id]) => !excludeIds.has(id)).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    let processed = 0
    while (processed < ordered.length && result.states.length < limit) {
      const page = ordered.slice(processed, processed + limit - result.states.length)
      const progressAndStates = await this.getProgressAndStates(user.id, page.map(([id]) => heldById.get(id)))
      for (const [id, changedMs] of page) {
        processed++
        result.lastModified = changedMs
        const { mediaProgress, stored } = progressAndStates.get(id)
        // Only the audiobook position moved: the device already has this state
        if (stored?.snapshot === this.getSnapshot(mediaProgress) && stored.updatedAt.valueOf() <= since.valueOf()) continue
        try {
          const state = await this.getReadingState(user, heldById.get(id).libraryItem, { mediaProgress, stored })
          if (state) result.states.push(state)
        } catch (error) {
          Logger.error(`[KoboReadingStateManager] Skipping reading state for ${id}: ${error.message}`)
        }
      }
    }
    result.hasMore = processed < ordered.length
    // The cursor only moves past everything once nothing is left for a later page
    if (!result.hasMore) result.lastModified = Math.max(result.lastModified, ...changed.values())
    return result
  }

  /**
   * PUT /v1/library/<id>/state from the device. Every key is optional.
   *
   * @param {import('../models/User')} user
   * @param {import('../models/LibraryItem')} libraryItem expanded
   * @param {Object} incoming one element of ReadingStates
   * @returns {Promise<{ error?: string, statusCode?: number }>}
   */
  async applyDeviceState(user, libraryItem, incoming) {
    const stored = await Database.koboReadingStateModel.getForUserItem(user.id, libraryItem.id)
    const values = {
      lastModified: typeof incoming.LastModified === 'string' ? incoming.LastModified : stored?.lastModified || koboTimestamp(Date.now()),
      priorityTimestamp: typeof incoming.PriorityTimestamp === 'string' ? incoming.PriorityTimestamp : stored?.priorityTimestamp || null
    }
    if (incoming.CurrentBookmark && typeof incoming.CurrentBookmark === 'object') values.currentBookmark = incoming.CurrentBookmark
    if (incoming.StatusInfo && typeof incoming.StatusInfo === 'object') values.statusInfo = incoming.StatusInfo
    if (incoming.Statistics && typeof incoming.Statistics === 'object') values.statistics = incoming.Statistics

    const payload = { libraryItemId: libraryItem.id }
    if (values.statusInfo?.Status === 'Finished') {
      // Never the other way: unfinishing an ABS item resets its audiobook position to 0
      payload.isFinished = true
      payload.ebookProgress = 1
    } else if (values.currentBookmark) {
      const { deviceMap, cfiBookMap } = await this.getMaps(libraryItem, values.currentBookmark.Location?.Type === 'KoboSpan')
      const spot = locateBookmark(deviceMap, values.currentBookmark, { cfiBookMap })
      if (spot) {
        payload.ebookProgress = spot.progress
        if (spot.cfi) payload.ebookLocation = spot.cfi
        Logger.debug(`[KoboReadingStateManager] "${libraryItem.media.title}" at ${(spot.progress * 100).toFixed(4)}% (${spot.method})`)
      }
    }

    let mediaProgress
    if (Object.keys(payload).length > 1) {
      const response = await user.createUpdateMediaProgressFromPayload(payload)
      if (response.error) return { error: response.error, statusCode: response.statusCode }
      mediaProgress = response.mediaProgress
      SocketAuthority.clientEmitter(user.id, 'user_updated', user.toOldJSONForBrowser())
    } else {
      mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id, mediaItemId: libraryItem.mediaId } })
    }
    values.snapshot = this.getSnapshot(mediaProgress)

    await this.saveState(user.id, libraryItem.id, values)
    return {}
  }

  /**
   * A kepub was just downloaded: a state built without one (a bare percentage) is rebuilt on
   * the next sync with a KoboSpan bookmark.
   *
   * @param {import('../models/User')} user
   * @param {import('../models/LibraryItem')} libraryItem
   */
  async touchAfterDownload(user, libraryItem) {
    const { mediaProgress, stored } = (await this.getProgressAndStates(user.id, [libraryItem])).get(libraryItem.id)
    if (this.getStatus(mediaProgress) !== 'Reading' || stored?.currentBookmark?.Location?.Type === 'KoboSpan') return
    await this.saveState(user.id, libraryItem.id, { snapshot: null })
  }

  /**
   * Create or update the stored state in one statement, so concurrent requests cannot both insert
   *
   * @param {string} userId
   * @param {string} libraryItemId
   * @param {Object} values
   */
  saveState(userId, libraryItemId, values) {
    return Database.koboReadingStateModel.upsert({ userId, libraryItemId, ...values }, { conflictFields: ['userId', 'libraryItemId'] })
  }
}

module.exports = new KoboReadingStateManager()
