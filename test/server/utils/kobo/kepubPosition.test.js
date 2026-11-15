const chai = require('chai')
const expect = chai.expect
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const htmlparser2 = require('htmlparser2')
const archiver = require('../../../../server/libs/archiver')
const Logger = require('../../../../server/Logger')
const { buildBookMap, locateBookmark, bookmarkFromProgress, findChapter, normalizeSource, cfiAt, parseCfi } = require('../../../../server/utils/kobo/kepubPosition')

const CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'

const OPF =
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
  '<metadata/><manifest>' +
  '<item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
  '<item href="Text/ch%202.xhtml" id="ch2" media-type="application/xhtml+xml"/>' +
  '</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>'

const CHAPTER_ONE_TEXT = 'It was a long night. The ship drifted.'

const CHAPTER_ONE = '<?xml version="1.0" encoding="utf-8"?>' + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>' + '<body><h1>It was a long night.</h1><p> The ship <!-- note -->drifted.</p></body></html>'

const CHAPTER_TWO_TEXT = 'Morning came. Nobody spoke.Then the engines started.'

// Kepub style: wrapper divs and one koboSpan per sentence
const CHAPTER_TWO =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head>' +
  '<body><div id="book-columns"><div id="book-inner">' +
  '<p><span class="koboSpan" id="kobo.1.1">Morning came. </span>' +
  '<span class="koboSpan" id="kobo.1.2">Nobody spoke.</span></p>' +
  '<p><span class="koboSpan" id="kobo.2.1">Then the <em>engines</em> started.</span></p>' +
  '</div></div></body></html>'

// The same chapter as a plain epub (what the ABS web reader opens)
const CHAPTER_TWO_PLAIN = '<?xml version="1.0" encoding="utf-8"?>' + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head>' + '<body><p>Morning came. Nobody spoke.</p><p>Then the <em>engines</em> started.</p></body></html>'

const DOCUMENTS = [CHAPTER_ONE, CHAPTER_TWO]

const tempFiles = []

/**
 * Write a zip of `entries` ([name, content] pairs) to a temp file.
 *
 * @param {[string, string|Buffer][]} entries
 * @returns {Promise<string>}
 */
function writeZip(entries) {
  const file = Path.join(os.tmpdir(), `kepubPosition-${process.pid}-${tempFiles.length}.epub`)
  tempFiles.push(file)
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file)
    const archive = archiver('zip', { zlib: { level: 6 } })
    output.on('close', () => resolve(file))
    archive.on('error', reject)
    archive.pipe(output)
    for (const [name, content] of entries) archive.append(content, { name, store: name === 'mimetype' })
    archive.finalize()
  })
}

/**
 * @param {{ encodedName?: boolean }} [options]
 */
function sampleKepub({ encodedName = false } = {}) {
  return writeZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', CONTAINER],
    ['OEBPS/content.opf', OPF],
    ['OEBPS/Text/ch1.xhtml', CHAPTER_ONE],
    // Some archives store the name percent-encoded; the map must find it either way
    [encodedName ? 'OEBPS/Text/ch%202.xhtml' : 'OEBPS/Text/ch 2.xhtml', CHAPTER_TWO]
  ])
}

function samplePlainEpub() {
  return writeZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', CONTAINER],
    ['OEBPS/content.opf', OPF],
    ['OEBPS/Text/ch1.xhtml', CHAPTER_ONE],
    ['OEBPS/Text/ch 2.xhtml', CHAPTER_TWO_PLAIN]
  ])
}

const isElement = (node) => node.type === 'tag' || node.type === 'script' || node.type === 'style'

/**
 * A small, independent CFI reader: the text that starts at the CFI's character.
 * Follows the spec rather than the code under test: even steps are element children, odd
 * steps are the runs of text between them, and the offset counts characters into that run.
 *
 * @param {string} cfi
 * @param {string[]} documents
 * @returns {string}
 */
function resolveCfi(cfi, documents) {
  const match = /^epubcfi\(\/6\/(\d+)\[[^\]]*\]!((?:\/\d+)+):(\d+)\)$/.exec(cfi)
  expect(match, cfi).to.not.equal(null)
  const spineIndex = Number(match[1]) / 2 - 1
  const steps = match[2].slice(1).split('/').map(Number)
  const offset = Number(match[3])
  const doc = htmlparser2.parseDocument(documents[spineIndex], { xmlMode: true })
  let node = doc.children.find(isElement)
  for (const step of steps.slice(0, -1)) {
    node = node.children.filter(isElement)[step / 2 - 1]
  }
  const chunk = steps[steps.length - 1]
  expect(chunk % 2, 'the last step points at text').to.equal(1)
  let k = 0
  let text = ''
  for (const child of node.children) {
    if (isElement(child)) k++
    else if (child.type === 'text' && k * 2 + 1 === chunk) text += child.data
  }
  return text.slice(offset)
}

describe('kepubPosition', () => {
  let book

  beforeEach(async () => {
    sinon.stub(Logger, 'warn')
    book = await buildBookMap(await sampleKepub())
  })

  afterEach(() => {
    sinon.restore()
  })

  after(() => {
    for (const file of tempFiles) fs.rmSync(file, { force: true })
  })

  describe('buildBookMap', () => {
    it('counts every chapter in spine order', () => {
      expect(book.chapters.map((chapter) => chapter.source)).to.deep.equal(['OEBPS/Text/ch1.xhtml', 'OEBPS/Text/ch 2.xhtml'])
      expect(book.chapters.map((chapter) => chapter.idref)).to.deep.equal(['ch1', 'ch2'])
      expect(book.chapters[0].length).to.equal(CHAPTER_ONE_TEXT.length)
      expect(book.chapters[1].start).to.equal(CHAPTER_ONE_TEXT.length)
      expect(book.length).to.equal(CHAPTER_ONE_TEXT.length + CHAPTER_TWO_TEXT.length)
      expect([...book.chapters[1].spans.keys()]).to.deep.equal(['kobo.1.1', 'kobo.1.2', 'kobo.2.1'])
      expect(book.chapters[0].spans.size).to.equal(0)
    })

    it('finds entries stored with percent-encoded names', async () => {
      const encoded = await buildBookMap(await sampleKepub({ encodedName: true }))
      expect(encoded.chapters[1].source).to.equal('OEBPS/Text/ch 2.xhtml')
      expect(encoded.length).to.equal(book.length)
      expect(encoded.chapters[1].spans.get('kobo.2.1')).to.equal(book.chapters[1].spans.get('kobo.2.1'))
    })

    it('falls back to the first OPF without a container.xml', async () => {
      const file = await writeZip([
        ['mimetype', 'application/epub+zip'],
        ['OEBPS/content.opf', OPF],
        ['OEBPS/Text/ch1.xhtml', CHAPTER_ONE],
        ['OEBPS/Text/ch 2.xhtml', CHAPTER_TWO]
      ])
      const fallback = await buildBookMap(file)
      expect(fallback.chapters).to.have.length(2)
      expect(fallback.length).to.equal(book.length)
    })

    it('tolerates malformed and unreadable chapters', async () => {
      const opf =
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>' +
        '<item id="bin" href="Text/drm.xhtml"/><item id="broken" href="Text/broken.xhtml"/>' +
        '<item id="gone" href="Text/missing.xhtml"/><item id="ch1" href="Text/ch1.xhtml"/>' +
        '</manifest><spine><itemref idref="bin"/><itemref idref="broken"/><itemref idref="gone"/><itemref idref="nope"/><itemref idref="ch1"/></spine></package>'
      const garbage = Buffer.alloc(4096)
      for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7919) % 256
      const file = await writeZip([
        ['META-INF/container.xml', CONTAINER],
        ['OEBPS/content.opf', opf],
        ['OEBPS/Text/drm.xhtml', garbage],
        ['OEBPS/Text/broken.xhtml', '<html><body><p>Broken <b>tags'],
        ['OEBPS/Text/ch1.xhtml', CHAPTER_ONE]
      ])
      const tolerant = await buildBookMap(file)
      expect(tolerant.chapters.map((chapter) => chapter.idref)).to.deep.equal(['bin', 'broken', 'ch1'])
      expect(tolerant.chapters[0].length).to.equal(0)
      expect(tolerant.chapters[1].length).to.equal('Broken tags'.length)
      expect(tolerant.chapters[2].spineIndex).to.equal(4)
      expect(tolerant.chapters[2].length).to.equal(CHAPTER_ONE_TEXT.length)
      expect(tolerant.length).to.equal('Broken tags'.length + CHAPTER_ONE_TEXT.length)
    })

    it('gives an empty map for a zip without an OPF', async () => {
      const empty = await buildBookMap(await writeZip([['readme.txt', 'nothing here']]))
      expect(empty).to.deep.equal({ chapters: [], length: 0 })
    })

    it('counts HTML entities as the characters they stand for and skips scripts and styles', async () => {
      const chapter = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>p{}</style></head><body><p>A&nbsp;B &amp; C&#233;</p><script>var x = 1</script><p><![CDATA[D]]>E</p></body></html>'
      const opf = '<package><manifest><item id="c" href="c.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>'
      const entityBook = await buildBookMap(await writeZip([['content.opf', opf], ['c.xhtml', chapter]]))
      expect(entityBook.chapters[0].source).to.equal('c.xhtml')
      expect(entityBook.length).to.equal('A B & CéDE'.length)
    })
  })

  describe('locateBookmark', () => {
    it('lands a KoboSpan on its exact character', () => {
      const spot = locateBookmark(book, { ProgressPercent: 50, Location: { Source: 'OEBPS/Text/ch%202.xhtml', Type: 'KoboSpan', Value: 'kobo.2.1' } })
      const before = CHAPTER_ONE_TEXT.length + 'Morning came. Nobody spoke.'.length
      expect(spot.method).to.equal('span')
      expect(spot.progress).to.equal(before / book.length)
      expect(spot.cfi).to.equal('epubcfi(/6/4[ch2]!/4/2/2/4/2/1:0)')
      expect(resolveCfi(spot.cfi, DOCUMENTS).startsWith('Then the')).to.equal(true)
    })

    it('resolves every span back to its own text', () => {
      const chapter = book.chapters[1]
      const expected = { 'kobo.1.1': 'Morning came.', 'kobo.1.2': 'Nobody spoke.', 'kobo.2.1': 'Then the' }
      for (const [spanId, text] of Object.entries(expected)) {
        const spot = locateBookmark(book, { Location: { Source: chapter.source, Type: 'KoboSpan', Value: spanId } })
        expect(resolveCfi(spot.cfi, DOCUMENTS).startsWith(text), spanId).to.equal(true)
      }
    })

    it('uses the chapter percentage when there is no span', () => {
      const spot = locateBookmark(book, { ProgressPercent: 3, ContentSourceProgressPercent: 50, Location: { Source: 'OEBPS/Text/ch1.xhtml', Type: 'Something', Value: 'x' } })
      const half = Math.floor(0.5 * CHAPTER_ONE_TEXT.length)
      expect(spot.method).to.equal('chapter')
      expect(spot.progress).to.equal(half / book.length)
      const resolved = resolveCfi(spot.cfi, DOCUMENTS)
      expect(resolved).to.not.equal('')
      expect(CHAPTER_ONE_TEXT.slice(half).startsWith(resolved)).to.equal(true)
    })

    it('keeps the offset counting across a comment inside a paragraph', () => {
      const target = CHAPTER_ONE_TEXT.indexOf('drifted')
      const cfi = cfiAt(book.chapters[0], target)
      expect(cfi).to.equal('epubcfi(/6/2[ch1]!/4/4/1:10)')
      expect(resolveCfi(cfi, DOCUMENTS).startsWith('drifted')).to.equal(true)
    })

    it('gives a CFI that resolves to the right text for every character', () => {
      book.chapters.forEach((chapter, index) => {
        const text = index === 0 ? CHAPTER_ONE_TEXT : CHAPTER_TWO_TEXT
        for (let offset = 0; offset < chapter.length; offset++) {
          const resolved = resolveCfi(cfiAt(chapter, offset), DOCUMENTS)
          expect(resolved[0], `${chapter.idref}@${offset}`).to.equal(text[offset])
        }
      })
    })

    it('falls back to the whole-book percentage for an unknown chapter', () => {
      const spot = locateBookmark(book, { ProgressPercent: 42, Location: { Source: 'OEBPS/Text/missing.xhtml', Type: 'KoboSpan', Value: 'kobo.1.1' } })
      expect(spot).to.deep.equal({ progress: 0.42, cfi: null, method: 'percent' })
    })

    it('ignores a bookmark with nothing usable', () => {
      expect(locateBookmark(book, { Location: {} })).to.equal(null)
      expect(locateBookmark(null, {})).to.equal(null)
      expect(locateBookmark(book, null)).to.equal(null)
    })

    it('writes the CFI against the plain epub when given its map', async () => {
      const plain = await buildBookMap(await samplePlainEpub())
      const spot = locateBookmark(book, { Location: { Source: 'OEBPS/Text/ch 2.xhtml', Type: 'KoboSpan', Value: 'kobo.2.1' } }, { cfiBookMap: plain })
      expect(spot.method).to.equal('span')
      expect(spot.cfi).to.equal('epubcfi(/6/4[ch2]!/4/4/1:0)')
      expect(resolveCfi(spot.cfi, [CHAPTER_ONE, CHAPTER_TWO_PLAIN]).startsWith('Then the')).to.equal(true)
    })
  })

  describe('findChapter / normalizeSource', () => {
    it('matches sources as zip paths', () => {
      expect(normalizeSource('Text/ch%202.xhtml#frag', 'OEBPS')).to.equal('OEBPS/Text/ch 2.xhtml')
      expect(normalizeSource('/OEBPS/Text/ch1.xhtml')).to.equal('OEBPS/Text/ch1.xhtml')
      expect(normalizeSource('bad%zzname')).to.equal('bad%zzname')
      expect(normalizeSource('')).to.equal(null)
      expect(findChapter(book, 'Text/ch1.xhtml').source).to.equal('OEBPS/Text/ch1.xhtml')
      expect(findChapter(book, 'OEBPS/Text/ch%202.xhtml').idref).to.equal('ch2')
      expect(findChapter(book, 'root/OEBPS/Text/ch1.xhtml').idref).to.equal('ch1')
      expect(findChapter(book, 'ch3.xhtml')).to.equal(null)
      expect(findChapter(book, null)).to.equal(null)
    })
  })

  describe('parseCfi', () => {
    it('parses spine steps with and without an idref', () => {
      expect(parseCfi('epubcfi(/6/4[ch2]!/4/2/2/4/2/1:0)')).to.deep.equal({ spineStep: 4, idref: 'ch2', steps: [4, 2, 2, 4, 2, 1], offset: 0 })
      expect(parseCfi('epubcfi(/6/4!/4/2/1:7)')).to.deep.equal({ spineStep: 4, idref: null, steps: [4, 2, 1], offset: 7 })
    })

    it('parses a range CFI to its start', () => {
      expect(parseCfi('epubcfi(/6/4!/4/2,/1:0,/1:5)')).to.deep.equal({ spineStep: 4, idref: null, steps: [4, 2, 1], offset: 0 })
      expect(parseCfi('epubcfi(/6/4[ch2]!/4/2/1,:3,:9)')).to.deep.equal({ spineStep: 4, idref: 'ch2', steps: [4, 2, 1], offset: 3 })
    })

    it('tolerates element assertions, text assertions and side bias', () => {
      expect(parseCfi('epubcfi(/6/4[ch,2]!/4[body01]/2[book-columns]/1:2[Mor,ning;s=b])')).to.deep.equal({ spineStep: 4, idref: 'ch,2', steps: [4, 2, 1], offset: 2 })
      expect(parseCfi('epubcfi(/6/4[a^]b]!/4)')).to.deep.equal({ spineStep: 4, idref: 'a]b', steps: [4], offset: 0 })
    })

    it('rejects what is not a CFI', () => {
      expect(parseCfi('not a cfi')).to.equal(null)
      expect(parseCfi('epubcfi()')).to.equal(null)
      expect(parseCfi('epubcfi(/6/x!/4)')).to.equal(null)
      expect(parseCfi('epubcfi(/6/4!/4,/1:0)')).to.equal(null)
      expect(parseCfi(null)).to.equal(null)
    })
  })

  describe('bookmarkFromProgress', () => {
    it('round-trips every span through its CFI', () => {
      const chapter = book.chapters[1]
      for (const spanId of chapter.spans.keys()) {
        const spot = locateBookmark(book, { Location: { Source: chapter.source, Type: 'KoboSpan', Value: spanId } })
        const bookmark = bookmarkFromProgress(book, { ebookLocation: spot.cfi, ebookProgress: spot.progress })
        expect(bookmark.Location, spanId).to.deep.equal({ Source: 'OEBPS/Text/ch 2.xhtml', Type: 'KoboSpan', Value: spanId })
        expect(bookmark.ProgressPercent).to.equal(Math.round(spot.progress * 100))
        expect(bookmark.ContentSourceProgressPercent).to.equal(Math.round((chapter.spans.get(spanId) / chapter.length) * 100))
      }
    })

    it('picks the span at or before a CFI inside a span', () => {
      const offset = 'Morning came. Nob'.length
      const bookmark = bookmarkFromProgress(book, { ebookLocation: cfiAt(book.chapters[1], offset), ebookProgress: 0.01 })
      expect(bookmark.Location.Value).to.equal('kobo.1.2')
      expect(bookmark.ProgressPercent).to.equal(Math.round(((CHAPTER_ONE_TEXT.length + offset) / book.length) * 100))
      expect(Number.isInteger(bookmark.ProgressPercent)).to.equal(true)
      expect(Number.isInteger(bookmark.ContentSourceProgressPercent)).to.equal(true)
    })

    it('uses the CFI spine step, with and without an idref, and a range start', () => {
      const withId = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/4[ch2]!/4/2/2/4/2/1:0)' })
      const withoutId = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/4!/4/2/2/4/2/1:0)' })
      const range = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/4!/4/2/2/4/2,/1:0,/1:5)' })
      expect(withId.Location.Value).to.equal('kobo.2.1')
      expect(withoutId).to.deep.equal(withId)
      expect(range).to.deep.equal(withId)
    })

    it('trusts the idref when the spine step disagrees', () => {
      const bookmark = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/8[ch2]!/4/2/2/4/2/1:0)' })
      expect(bookmark.Location.Value).to.equal('kobo.2.1')
    })

    it('places a CFI that points at an element on its first text', () => {
      // The second <p> in chapter two, no text step
      const bookmark = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/4!/4/2/2/4)' })
      expect(bookmark.Location.Value).to.equal('kobo.2.1')
      const top = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/4[ch2]!/4)' })
      expect(top.Location.Value).to.equal('kobo.1.1')
      expect(top.ContentSourceProgressPercent).to.equal(0)
    })

    it('maps a CFI on the plain epub onto the kepub span', async () => {
      const plain = await buildBookMap(await samplePlainEpub())
      const offset = 'Morning came. Nobody spoke.Then the en'.length
      const cfi = cfiAt(plain.chapters[1], offset)
      expect(cfi).to.equal('epubcfi(/6/4[ch2]!/4/4/2/1:2)')
      const bookmark = bookmarkFromProgress(book, { ebookLocation: cfi }, { cfiBookMap: plain })
      expect(bookmark.Location).to.deep.equal({ Source: 'OEBPS/Text/ch 2.xhtml', Type: 'KoboSpan', Value: 'kobo.2.1' })
      expect(bookmark.ProgressPercent).to.equal(Math.round(((CHAPTER_ONE_TEXT.length + offset) / book.length) * 100))
    })

    it('places a bare percentage across chapters by character count', () => {
      const into = (CHAPTER_ONE_TEXT.length + 'Morning came. Nobody'.length) / book.length
      const bookmark = bookmarkFromProgress(book, { ebookLocation: null, ebookProgress: into })
      expect(bookmark.Location).to.deep.equal({ Source: 'OEBPS/Text/ch 2.xhtml', Type: 'KoboSpan', Value: 'kobo.1.2' })
      expect(bookmark.ProgressPercent).to.equal(Math.round(into * 100))
      expect(bookmark.ContentSourceProgressPercent).to.equal(Math.round(('Morning came. Nobody'.length / CHAPTER_TWO_TEXT.length) * 100))

      const start = bookmarkFromProgress(book, { ebookProgress: 0 })
      expect(start).to.deep.equal({ ProgressPercent: 0, ContentSourceProgressPercent: 0 })
      const end = bookmarkFromProgress(book, { ebookProgress: 1 })
      expect(end.Location.Value).to.equal('kobo.2.1')
      expect(end.ProgressPercent).to.equal(100)
    })

    it('falls back to the percentage when the CFI does not parse or resolve', () => {
      const bookmark = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(garbage)', ebookProgress: 0.9 })
      expect(bookmark.Location.Value).to.equal('kobo.2.1')
      expect(bookmark.ProgressPercent).to.equal(90)
      const unknownSpine = bookmarkFromProgress(book, { ebookLocation: 'epubcfi(/6/40!/4/1:0)', ebookProgress: 0.9 })
      expect(unknownSpine).to.deep.equal(bookmark)
    })

    it('returns only percentages for a plain epub', async () => {
      const plain = await buildBookMap(await samplePlainEpub())
      const bookmark = bookmarkFromProgress(plain, { ebookLocation: 'epubcfi(/6/4[ch2]!/4/4/1:0)', ebookProgress: 0.5 })
      expect(bookmark).to.not.have.property('Location')
      const offset = CHAPTER_ONE_TEXT.length + 'Morning came. Nobody spoke.'.length
      expect(bookmark.ProgressPercent).to.equal(Math.round((offset / plain.length) * 100))
      expect(bookmark.ContentSourceProgressPercent).to.equal(Math.round(('Morning came. Nobody spoke.'.length / CHAPTER_TWO_TEXT.length) * 100))
    })

    it('returns null when nothing is usable', () => {
      expect(bookmarkFromProgress(book, {})).to.equal(null)
      expect(bookmarkFromProgress(book, { ebookLocation: 'epubcfi(garbage)' })).to.equal(null)
      expect(bookmarkFromProgress(null, {})).to.equal(null)
      expect(bookmarkFromProgress({ chapters: [], length: 0 }, { ebookProgress: 0.25 })).to.deep.equal({ ProgressPercent: 25 })
    })
  })
})
