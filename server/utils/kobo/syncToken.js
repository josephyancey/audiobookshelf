const Logger = require('../../Logger')

/**
 * The `x-kobo-synctoken` a Kobo sends with every library sync and echoes back unchanged.
 *
 * Wire format matches Calibre-Web: base64 of `{ version, data }` JSON. The device treats it as
 * opaque. Lessons carried over from Calibre-Web:
 * - It must go out as a plain string. A `b'...'` bytes repr made every sync look like the first
 *   one and the device looped forever (Calibre-Web b1d7bade, #3017).
 * - Missing base64 padding is tolerated.
 * - A token containing a "." is the store's own token, sent on the first sync after switching
 *   from the Kobo store. It is kept so the store can still be merged, and everything else
 *   starts fresh.
 * - Anything unreadable starts fresh instead of failing the sync.
 *
 * `checkpoint` is ours: the id of the page this token was issued with. The device presenting
 * it is the confirmation that the page arrived (see KoboSyncedItem).
 */

const VERSION = '1-1-0'

/**
 * @typedef KoboSyncToken
 * @property {string} rawKoboStoreToken
 * @property {string|null} checkpoint
 * @property {number} readingStateLastModified epoch ms
 */

/**
 * @returns {KoboSyncToken}
 */
function createSyncToken() {
  return {
    rawKoboStoreToken: '',
    checkpoint: null,
    readingStateLastModified: 0
  }
}

/**
 * @param {string|undefined} header
 * @returns {KoboSyncToken}
 */
function parseSyncToken(header) {
  const token = createSyncToken()
  if (!header || typeof header !== 'string') return token

  if (header.includes('.')) {
    token.rawKoboStoreToken = header
    return token
  }

  try {
    const padded = header + '='.repeat((4 - (header.length % 4)) % 4)
    const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const data = json?.data
    if (!data || typeof data !== 'object' || typeof json.version !== 'string') {
      throw new Error('missing version or data')
    }
    token.rawKoboStoreToken = typeof data.raw_kobo_store_token === 'string' ? data.raw_kobo_store_token : ''
    token.checkpoint = typeof data.checkpoint === 'string' ? data.checkpoint : null
    token.readingStateLastModified = Number.isFinite(data.reading_state_last_modified) ? data.reading_state_last_modified : 0
  } catch (error) {
    Logger.warn(`[syncToken] Sync token does not follow the expected format, starting a fresh sync: ${error.message}`)
    return createSyncToken()
  }
  return token
}

/**
 * @param {KoboSyncToken} token
 * @returns {string}
 */
function buildSyncToken(token) {
  const json = {
    version: VERSION,
    data: {
      raw_kobo_store_token: token.rawKoboStoreToken || '',
      checkpoint: token.checkpoint || null,
      reading_state_last_modified: token.readingStateLastModified || 0
    }
  }
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
}

module.exports = {
  VERSION,
  createSyncToken,
  parseSyncToken,
  buildSyncToken
}
