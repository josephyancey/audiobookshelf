const uuid = require('uuid')

/**
 * Builders for the JSON a Kobo expects, field for field as Calibre-Web sends it
 */

const DEFAULT_CATEGORY = '00000000-0000-0000-0000-000000000001'

/**
 * Kobo timestamps have no fractional seconds: 2026-11-14T22:40:16Z
 *
 * @param {Date|number|string|null} value
 * @param {Date|number} [fallback] used when value is missing or invalid
 * @returns {string}
 */
function koboTimestamp(value, fallback = Date.now()) {
  let date = value instanceof Date ? value : value !== null && value !== undefined && value !== '' ? new Date(value) : null
  if (!date || isNaN(date.valueOf())) date = new Date(fallback)
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

let languageNameMap = null

/**
 * Map of lowercase English language names to ISO 639-1 codes, built from ICU once
 * @returns {Map<string, string>}
 */
function getLanguageNameMap() {
  if (languageNameMap) return languageNameMap
  languageNameMap = new Map()
  const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b
      try {
        const name = displayNames.of(code)
        if (name && name !== code) languageNameMap.set(name.toLowerCase(), code)
      } catch {
        // not a language code
      }
    }
  }
  return languageNameMap
}

/**
 * The two letter language code the device expects. ABS stores free text ("English", "en",
 * "eng", "en-US"); anything unrecognised falls back to "en" like Calibre-Web.
 *
 * @param {string|null} language
 * @returns {string}
 */
function toIsoLanguage(language) {
  if (!language || typeof language !== 'string') return 'en'
  const value = language.trim()
  if (!value) return 'en'
  const byName = getLanguageNameMap().get(value.toLowerCase())
  if (byName) return byName
  try {
    const [canonical] = Intl.getCanonicalLocales(value.replace(/_/g, '-'))
    const code = new Intl.Locale(canonical).language
    if (/^[a-z]{2}$/.test(code)) return code
  } catch {
    // not a locale tag
  }
  return 'en'
}

/**
 * @param {import('../../models/LibraryItem')} libraryItem expanded, with media.authors and media.series
 * @returns {{ Name: string, Number: number, NumberFloat: number, Id: string }|null}
 */
function buildSeries(libraryItem) {
  const series = libraryItem.media.series?.[0]
  if (!series?.name) return null
  const sequence = parseFloat(series.bookSeries?.sequence)
  const number = Number.isFinite(sequence) ? sequence : 1
  return {
    Name: series.name,
    Number: number,
    NumberFloat: number,
    // Same id as Calibre-Web: Python uuid3(NAMESPACE_DNS, name)
    Id: uuid.v3(series.name, uuid.v3.DNS)
  }
}

/**
 * @param {import('../../models/Book')} book
 * @returns {string|null}
 */
function getPublicationDate(book) {
  const value = book.publishedDate || (book.publishedYear ? `${book.publishedYear}-01-01` : null)
  if (!value) return null
  const date = new Date(/^\d{4}$/.test(value) ? `${value}-01-01` : value)
  return isNaN(date.valueOf()) ? null : koboTimestamp(date)
}

/**
 * @param {import('../../models/LibraryItem')} libraryItem
 * @param {{ isRemoved: boolean }} options
 * @returns {Object}
 */
function buildBookEntitlement(libraryItem, { isRemoved }) {
  const id = libraryItem.id
  return {
    Accessibility: 'Full',
    ActivePeriod: { From: koboTimestamp(Date.now()) },
    Created: koboTimestamp(libraryItem.createdAt),
    CrossRevisionId: id,
    Id: id,
    IsRemoved: !!isRemoved,
    IsHiddenFromArchive: false,
    IsLocked: false,
    LastModified: koboTimestamp(libraryItem.updatedAt, libraryItem.createdAt),
    OriginCategory: 'Imported',
    RevisionId: id,
    Status: 'Active'
  }
}

/**
 * An entitlement for an item that no longer exists, so it can still be removed from the device
 *
 * @param {string} libraryItemId
 * @returns {Object}
 */
function buildRemovedEntitlement(libraryItemId) {
  const now = new Date()
  return { BookEntitlement: buildBookEntitlement({ id: libraryItemId, createdAt: now, updatedAt: now }, { isRemoved: true }) }
}

/**
 * @typedef KoboDownloadUrl
 * @property {string} Format
 * @property {number} Size
 * @property {string} Url
 * @property {string} Platform
 */

/**
 * @param {import('../../models/LibraryItem')} libraryItem expanded
 * @param {{ downloadUrls: KoboDownloadUrl[], coverImageId: string }} options
 * @returns {Object}
 */
function buildBookMetadata(libraryItem, { downloadUrls, coverImageId }) {
  const book = libraryItem.media
  const id = libraryItem.id
  const authorNames = (book.authors || []).map((author) => author.name).filter(Boolean)
  const metadata = {
    Categories: [DEFAULT_CATEGORY],
    CoverImageId: coverImageId,
    CrossRevisionId: id,
    CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
    CurrentLoveDisplayPrice: { TotalAmount: 0 },
    Description: book.description || null,
    DownloadUrls: downloadUrls,
    EntitlementId: id,
    ExternalIds: [],
    Genre: DEFAULT_CATEGORY,
    IsEligibleForKoboLove: false,
    IsInternetArchive: false,
    IsPreOrder: false,
    IsSocialEnabled: true,
    Language: toIsoLanguage(book.language),
    PhoneticPronunciations: {},
    Publisher: { Imprint: '', Name: book.publisher || null },
    RevisionId: id,
    Title: book.title || libraryItem.title || 'Untitled',
    WorkId: id,
    Contributors: authorNames.length ? authorNames : null,
    ContributorRoles: authorNames.map((name) => ({ Name: name }))
  }
  const publicationDate = getPublicationDate(book)
  if (publicationDate) metadata.PublicationDate = publicationDate
  const series = buildSeries(libraryItem)
  if (series) metadata.Series = series
  return metadata
}

/**
 * Kobo "Tag" for a collection. Items always carry the full book list, so a ChangedTag
 * replaces the collection's contents on the device.
 *
 * @param {import('../../models/Collection')} collection
 * @param {string[]} libraryItemIds
 * @returns {Object}
 */
function buildTag(collection, libraryItemIds) {
  return {
    Tag: {
      Created: koboTimestamp(collection.createdAt),
      Id: collection.id,
      Items: libraryItemIds.map((libraryItemId) => ({ RevisionId: libraryItemId, Type: 'ProductRevisionTagItem' })),
      LastModified: koboTimestamp(collection.updatedAt, collection.createdAt),
      Name: collection.name,
      Type: 'UserTag'
    }
  }
}

/**
 * @param {string} collectionId
 * @returns {Object}
 */
function buildDeletedTag(collectionId) {
  return {
    Tag: {
      Id: collectionId,
      LastModified: koboTimestamp(Date.now())
    }
  }
}

module.exports = {
  koboTimestamp,
  toIsoLanguage,
  buildBookEntitlement,
  buildRemovedEntitlement,
  buildBookMetadata,
  buildTag,
  buildDeletedTag
}
