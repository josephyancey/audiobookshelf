/**
 * Kobo reading position <-> Audiobookshelf ebook progress.
 *
 * A Kobo reports where it is as `CurrentBookmark`:
 * - `Location`: `{ Source: '<chapter path in the zip>', Type: 'KoboSpan', Value: 'kobo.N.M' }`.
 *   KoboSpans only exist in a kepub and their ids restart in every chapter, so `Source`
 *   is what disambiguates them.
 * - `ContentSourceProgressPercent`: how far through that chapter, 0 to 100.
 * - `ProgressPercent`: how far through the book, 0 to 100, rounded by the reader.
 *
 * ABS stores `ebookProgress` (fraction of the book) and `ebookLocation` (an EPUB CFI, what the
 * web reader restores from). This module reads the ebook itself so both directions are exact.
 *
 * Text is counted one way everywhere: every text node under `<body>`, in document order,
 * whitespace included, skipping `<script>`/`<style>`. CFI offsets are raw character offsets
 * (UTF-16 code units, like the DOM), so counting raw text keeps the two in step.
 *
 * The reverse direction follows BookBridge's
 * `kepub_locator` (MIT, cporcellijr).
 */

const Path = require('path')
const htmlparser2 = require('htmlparser2')
const StreamZip = require('../../libs/nodeStreamZip')
const Logger = require('../../Logger')

/**
 * @typedef Piece
 * One run of text: where it starts in its chapter and the CFI of its first character.
 * `cfiPath` is the element path plus the odd step of the text chunk (e.g. `/4/2/6/3`).
 * `chunkOffset` is how many characters of that chunk come before this run; it is only
 * non-zero when a comment (or CDATA section) splits a chunk.
 * @property {number} start
 * @property {number} length
 * @property {string} cfiPath
 * @property {number} chunkOffset
 */

/**
 * @typedef Chapter
 * @property {string} source full zip path, decoded, as Kobo reports `Location.Source`
 * @property {number} spineIndex 0-based position in the OPF spine
 * @property {string} idref
 * @property {number} start characters before this chapter
 * @property {number} length
 * @property {Piece[]} pieces
 * @property {Map<string, number>} spans koboSpan id -> chapter offset, in document order
 */

/**
 * @typedef BookMap
 * @property {Chapter[]} chapters
 * @property {number} length
 */

/**
 * @typedef Position
 * @property {number} progress exact fraction of the book, 0..1
 * @property {string|null} cfi
 * @property {'span'|'chapter'|'percent'} method
 */

/**
 * @typedef ParsedCfi
 * @property {number|null} spineStep even spine step (`/6/N` -> N)
 * @property {string|null} idref the `[idref]` assertion on the spine step, if any
 * @property {number[]} steps steps after the `!` indirection
 * @property {number} offset character offset (0 when absent)
 */

//
// Paths
//

/**
 * Percent-decode a zip path, leaving it as it is when it is not valid
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Join like Python's `posixpath.normpath(posixpath.join(dir, href))`.
 *
 * @param {string} dir
 * @param {string} href
 * @returns {string}
 */
function joinZipPath(dir, href) {
  if (!dir || href.startsWith('/')) return Path.posix.normalize(href)
  return Path.posix.join(dir, href)
}

/**
 * A spine href as a full zip path: decoded, anchor and leading slashes removed.
 *
 * @param {string} href
 * @param {string} [opfDir]
 * @returns {string|null}
 */
function normalizeSource(href, opfDir = '') {
  if (!href) return null
  let path = unquote(String(href).replace(/#.*$/, '').replace(/\\/g, '/'))
  if (opfDir) path = joinZipPath(opfDir, path)
  return path.replace(/^\/+/, '')
}

/**
 * The chapter a reader's `Location.Source` names. Normally an exact match on the zip path;
 * the suffix match covers a reader that reports the path relative to the OPF.
 *
 * @param {BookMap} bookMap
 * @param {string} source
 * @returns {Chapter|null}
 */
function findChapter(bookMap, source) {
  if (!bookMap?.chapters) return null
  const target = normalizeSource(source)
  if (!target) return null
  const exact = bookMap.chapters.find((chapter) => chapter.source === target)
  if (exact) return exact
  return bookMap.chapters.find((chapter) => chapter.source.endsWith('/' + target) || target.endsWith('/' + chapter.source)) || null
}

//
// Reading the book
//

/**
 * @param {string} name
 * @returns {string}
 */
function localName(name) {
  return String(name || '')
    .split(':')
    .pop()
    .toLowerCase()
}

/**
 * @param {*} node domhandler node
 * @returns {boolean}
 */
function isElement(node) {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style'
}

/**
 * Decode entities in a raw text node. Browsers (and so epub.js and the Kobo reader) know the
 * HTML named entities in XHTML (`&nbsp;` is one character), which an XML parser does not.
 * The text has no markup left in it, so a tiny HTML-mode parse decodes it safely.
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeText(raw) {
  if (!raw.includes('&')) return raw
  let out = ''
  const parser = new htmlparser2.Parser({ ontext: (text) => (out += text) }, { decodeEntities: true })
  parser.write(raw)
  parser.end()
  return out
}

/**
 * Record every text run under `node` in document order. Returns the new cursor.
 *
 * CFI numbering: element children take even steps (2, 4, ...), and the run of non-element
 * content before, between and after them takes the odd steps. A comment is not an element,
 * so the text after it stays in the chunk it interrupts.
 *
 * @param {Chapter} chapter
 * @param {*} node
 * @param {string} path
 * @param {number} cursor
 * @returns {number}
 */
function walk(chapter, node, path, cursor) {
  /** @type {Object<number, number>} */
  const chunkUsed = {}
  let k = 0
  const add = (text, chunk) => {
    if (!text) return
    const already = chunkUsed[chunk] || 0
    chapter.pieces.push({ start: cursor, length: text.length, cfiPath: `${path}/${chunk}`, chunkOffset: already })
    chunkUsed[chunk] = already + text.length
    cursor += text.length
  }
  for (const child of node.children || []) {
    if (isElement(child)) {
      k++
      const attribs = child.attribs || {}
      if (attribs.id && (attribs.class || '').split(/\s+/).includes('koboSpan') && !chapter.spans.has(attribs.id)) {
        chapter.spans.set(attribs.id, cursor)
      }
      const name = localName(child.name)
      if (name !== 'script' && name !== 'style') {
        cursor = walk(chapter, child, `${path}/${k * 2}`, cursor)
      }
    } else if (child.type === 'text') {
      add(decodeText(child.data || ''), k * 2 + 1)
    } else if (child.type === 'cdata') {
      for (const inner of child.children || []) add(inner.data || '', k * 2 + 1)
    }
  }
  return cursor
}

/**
 * @param {Buffer} data
 * @param {Chapter} chapter
 */
function mapChapter(data, chapter) {
  const doc = htmlparser2.parseDocument(data.toString('utf8'), { xmlMode: true, decodeEntities: false })
  const root = (doc.children || []).find(isElement)
  if (!root) return
  const elements = (root.children || []).filter(isElement)
  const index = elements.findIndex((child) => localName(child.name) === 'body')
  if (index < 0) return
  chapter.length = walk(chapter, elements[index], `/${(index + 1) * 2}`, 0)
}

/**
 * @param {string} opfText
 * @returns {{ idref: string, href: string, index: number }[]} reading order; `index` is the itemref's position in the spine
 */
function parseSpine(opfText) {
  /** @type {Object<string, string>} */
  const manifest = {}
  /** @type {string[]} */
  const idrefs = []
  const parser = new htmlparser2.Parser(
    {
      onopentag: (name, attribs) => {
        const local = localName(name)
        if (local === 'item' && attribs.id && attribs.href) manifest[attribs.id] = attribs.href
        else if (local === 'itemref' && attribs.idref) idrefs.push(attribs.idref)
      }
    },
    { xmlMode: true }
  )
  parser.write(opfText)
  parser.end()
  return idrefs.map((idref, index) => ({ idref, href: manifest[idref], index })).filter((item) => item.href !== undefined)
}

/**
 * Read an epub or kepub into its chapters, text runs and KoboSpans.
 * One unreadable or malformed chapter becomes a zero-length chapter; a file that is not a
 * zip rejects (so the caller does not cache a transient failure); a zip without an OPF
 * gives an empty map.
 *
 * @param {string} ebookPath
 * @returns {Promise<BookMap>}
 */
async function buildBookMap(ebookPath) {
  /** @type {BookMap} */
  const bookMap = { chapters: [], length: 0 }
  const zip = new StreamZip.async({ file: ebookPath })
  try {
    const names = new Set(Object.keys(await zip.entries()))
    const read = (name) => zip.entryData(name)
    const container = names.has('META-INF/container.xml') ? (await read('META-INF/container.xml')).toString('utf8') : ''
    const opfPath = /full-path\s*=\s*"([^"]+)"/.exec(container)?.[1]
    if (!opfPath || !names.has(opfPath)) {
      Logger.warn(`[kepubPosition] No OPF in "${ebookPath}"`)
      return bookMap
    }
    const opfDir = Path.posix.dirname(opfPath) === '.' ? '' : Path.posix.dirname(opfPath)
    const spine = parseSpine((await read(opfPath)).toString('utf8'))

    let cursor = 0
    for (const { idref, href, index: spineIndex } of spine) {
      const source = normalizeSource(href, opfDir)
      let entry = source && names.has(source) ? source : null
      if (!entry) {
        // Some archives store the name percent-encoded, exactly as the href spells it
        const raw = joinZipPath(opfDir, href.replace(/#.*$/, '')).replace(/^\/+/, '')
        entry = names.has(raw) ? raw : null
      }
      if (!entry || !source) continue

      /** @type {Chapter} */
      const chapter = { source, spineIndex, idref, start: cursor, length: 0, pieces: [], spans: new Map() }
      try {
        mapChapter(await read(entry), chapter)
      } catch (error) {
        Logger.warn(`[kepubPosition] Unreadable chapter "${entry}" in "${ebookPath}": ${error.message}`)
        chapter.length = 0
        chapter.pieces = []
        chapter.spans = new Map()
      }
      cursor += chapter.length
      bookMap.chapters.push(chapter)
    }
    bookMap.length = cursor
    return bookMap
  } finally {
    await zip.close().catch(() => {})
  }
}

//
// Positions
//

/**
 * The CFI of the character `offset` characters into `chapter`.
 *
 * @param {Chapter} chapter
 * @param {number} offset
 * @returns {string}
 */
function cfiAt(chapter, offset) {
  const prefix = `/6/${(chapter.spineIndex + 1) * 2}[${chapter.idref}]!`
  if (!chapter.pieces.length) return `epubcfi(${prefix}/4)`
  offset = Math.max(0, Math.min(Math.floor(offset), Math.max(chapter.length - 1, 0)))
  let chosen = chapter.pieces[0]
  for (const piece of chapter.pieces) {
    if (piece.start <= offset) chosen = piece
    else break
  }
  const inside = Math.min(offset - chosen.start, Math.max(chosen.length - 1, 0))
  return `epubcfi(${prefix}${chosen.cfiPath}:${chosen.chunkOffset + Math.max(inside, 0)})`
}

/**
 * @param {*} value
 * @returns {number|null} 0..1
 */
function percent(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(0, Math.min(number / 100, 1))
}

/**
 * The chapter in `other` that corresponds to `chapter` (same source, else same spine index).
 *
 * @param {BookMap} other
 * @param {Chapter} chapter
 * @returns {Chapter|null}
 */
function counterpart(other, chapter) {
  return findChapter(other, chapter.source) || other.chapters.find((candidate) => candidate.spineIndex === chapter.spineIndex) || null
}

/**
 * Scale an offset from one chapter to its counterpart (identity when lengths match).
 *
 * @param {number} offset
 * @param {Chapter} from
 * @param {Chapter} to
 * @returns {number}
 */
function scaleOffset(offset, from, to) {
  if (from.length === to.length || !from.length) return Math.min(offset, to.length)
  return Math.floor((offset * to.length) / from.length)
}

/**
 * Where `currentBookmark` (a Kobo `CurrentBookmark`) points, as exactly as it allows.
 * In order of preference: the KoboSpan itself; the chapter plus the in-chapter percentage;
 * the whole-book percentage. Returns null when the bookmark carries nothing usable.
 *
 * `options.cfiBookMap` is the map of the book the CFI consumer reads (the original epub the
 * ABS web reader opens, when `bookMap` is the kepub): the CFI is then written against it.
 *
 * @param {BookMap|null} bookMap
 * @param {*} currentBookmark
 * @param {{ cfiBookMap?: BookMap }} [options]
 * @returns {Position|null}
 */
function locateBookmark(bookMap, currentBookmark, options = {}) {
  const bookmark = currentBookmark || {}
  const location = bookmark.Location || {}
  const whole = percent(bookmark.ProgressPercent)
  if (bookMap?.length) {
    const chapter = findChapter(bookMap, location.Source)
    if (chapter) {
      let offset = null
      let method = null
      if (location.Type === 'KoboSpan' && chapter.spans.has(location.Value)) {
        offset = chapter.spans.get(location.Value)
        method = 'span'
      } else {
        const inside = percent(bookmark.ContentSourceProgressPercent)
        if (inside !== null) {
          offset = Math.floor(inside * chapter.length)
          method = 'chapter'
        }
      }
      if (offset !== null) {
        let cfi = cfiAt(chapter, offset)
        const cfiChapter = options.cfiBookMap ? counterpart(options.cfiBookMap, chapter) : null
        if (options.cfiBookMap) cfi = cfiChapter ? cfiAt(cfiChapter, scaleOffset(offset, chapter, cfiChapter)) : null
        return { progress: (chapter.start + offset) / bookMap.length, cfi, method }
      }
    }
  }
  if (whole === null) return null
  return { progress: whole, cfi: null, method: 'percent' }
}

//
// ABS → Kobo
//

/**
 * Parse the CFIs epub.js stores, `epubcfi(/6/N[idref]!/4/2[id]/1:offset)`, or the start of a
 * range CFI `epubcfi(/6/N!/4/2,/1:0,/1:9)`
 *
 * @param {string} cfi
 * @returns {ParsedCfi|null}
 */
function parseCfi(cfi) {
  const match = /^epubcfi\(\/6\/(\d+)(?:\[([^\]]*)\])?!([^,)]*)(?:,([^,)]*),[^)]*)?\)$/.exec(cfi)
  if (!match) return null
  const path = match[3] + (match[4] || '')
  const offset = /:(\d+)/.exec(path)
  return {
    spineStep: Number(match[1]),
    idref: match[2] || null,
    steps: [...path.replace(/:.*$/, '').matchAll(/\/(\d+)/g)].map((step) => Number(step[1])),
    offset: offset ? Number(offset[1]) : 0
  }
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} document-order comparison of two step paths (an ancestor sorts first)
 */
function compareSteps(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * The chapter offset a CFI's content steps point at. A text step uses the piece of that chunk
 * holding the offset; an element step (or a chunk with no text) uses the first text at or
 * after it in document order.
 *
 * @param {Chapter} chapter
 * @param {number[]} steps
 * @param {number} offset
 * @returns {number}
 */
function offsetFromSteps(chapter, steps, offset) {
  if (!steps.length || !chapter.pieces.length) return 0
  const last = steps[steps.length - 1]
  if (last % 2 === 1) {
    const path = '/' + steps.join('/')
    const pieces = chapter.pieces.filter((piece) => piece.cfiPath === path)
    if (pieces.length) {
      let chosen = pieces[0]
      for (const piece of pieces) {
        if (piece.chunkOffset <= offset) chosen = piece
      }
      const inside = Math.max(0, Math.min(offset - chosen.chunkOffset, chosen.length))
      return Math.min(chosen.start + inside, chapter.length)
    }
  }
  const after = chapter.pieces.find((piece) => compareSteps(piece.cfiPath.split('/').slice(1).map(Number), steps) >= 0)
  return after ? after.start : chapter.length
}

/**
 * @param {BookMap} bookMap
 * @param {ParsedCfi} parsed
 * @returns {Chapter|null}
 */
function chapterForCfi(bookMap, parsed) {
  const spineIndex = parsed.spineStep / 2 - 1
  const bySpine = bookMap.chapters.find((chapter) => chapter.spineIndex === spineIndex)
  if (parsed.idref && (!bySpine || bySpine.idref !== parsed.idref)) {
    const byIdref = bookMap.chapters.find((chapter) => chapter.idref === parsed.idref)
    if (byIdref) return byIdref
  }
  return bySpine || null
}

/**
 * The KoboSpan at or before `offset` (the first span when the offset precedes them all).
 *
 * @param {Chapter} chapter
 * @param {number} offset
 * @returns {string|null}
 */
function spanAt(chapter, offset) {
  let chosen = null
  for (const [spanId, start] of chapter.spans) {
    if (chosen === null || start <= offset) chosen = spanId
    else break
  }
  return chosen
}

/**
 * @param {number} fraction
 * @returns {number} integer 0..100
 */
function toPercent(fraction) {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)))
}

/**
 * Build a Kobo `CurrentBookmark` fragment from ABS ebook progress: the CFI's chapter and
 * character when it parses, else `ebookProgress` placed across the chapters by character
 * count; then the KoboSpan at or before that character. Without spans in that chapter (a plain
 * epub) only the percentages are returned. Returns null when nothing is usable.
 *
 * `options.cfiBookMap` is the map of the book the CFI was written against (the original epub
 * the ABS web reader opens, when `bookMap` is the kepub on the device).
 *
 * @param {BookMap|null} bookMap
 * @param {{ ebookLocation?: string|null, ebookProgress?: number|null }} progress
 * @param {{ cfiBookMap?: BookMap }} [options]
 * @returns {{ Location?: { Source: string, Type: string, Value: string }, ProgressPercent: number, ContentSourceProgressPercent?: number }|null}
 */
function bookmarkFromProgress(bookMap, { ebookLocation, ebookProgress } = {}, options = {}) {
  const fraction = typeof ebookProgress === 'number' && Number.isFinite(ebookProgress) ? Math.max(0, Math.min(ebookProgress, 1)) : null

  /** @type {Chapter|null} */
  let chapter = null
  let offset = 0
  let progress = fraction

  if (bookMap?.length) {
    const parsed = typeof ebookLocation === 'string' ? parseCfi(ebookLocation) : null
    const cfiMap = options.cfiBookMap || bookMap
    const cfiChapter = parsed ? chapterForCfi(cfiMap, parsed) : null
    if (cfiChapter) {
      const cfiOffset = offsetFromSteps(cfiChapter, parsed.steps, parsed.offset)
      chapter = cfiMap === bookMap ? cfiChapter : counterpart(bookMap, cfiChapter)
      if (chapter) {
        offset = cfiMap === bookMap ? cfiOffset : scaleOffset(cfiOffset, cfiChapter, chapter)
        progress = (chapter.start + offset) / bookMap.length
      }
    }
    if (!chapter && fraction !== null) {
      const target = Math.max(0, Math.min(Math.floor(fraction * bookMap.length), bookMap.length - 1))
      chapter = bookMap.chapters[0]
      for (const candidate of bookMap.chapters) {
        if (candidate.start <= target) chapter = candidate
        else break
      }
      offset = Math.max(0, Math.min(fraction * bookMap.length - chapter.start, chapter.length))
    }
  }

  if (progress === null) return null
  if (!chapter) return { ProgressPercent: toPercent(progress) }

  const bookmark = {}
  const spanId = spanAt(chapter, offset)
  if (spanId !== null) bookmark.Location = { Source: chapter.source, Type: 'KoboSpan', Value: spanId }
  bookmark.ProgressPercent = toPercent(progress)
  bookmark.ContentSourceProgressPercent = chapter.length ? toPercent(offset / chapter.length) : 0
  return bookmark
}

module.exports = {
  buildBookMap,
  locateBookmark,
  bookmarkFromProgress,
  cfiAt
}
