const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const nodeFs = require('fs')
const archiver = require('../../../server/libs/archiver')
const Logger = require('../../../server/Logger')
const CacheManager = require('../../../server/managers/CacheManager')
const KepubManager = require('../../../server/managers/KepubManager')

const CONTAINER_XML = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'

const opf = (meta = '') => `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>${meta}</metadata><manifest/><spine/></package>`

/**
 * Fake kepubify: `kepubify <src> -o <dir> -i` writes `<dir>/<basename>.kepub.epub` containing "KEPUB:" + source content.
 * Behavior is controlled by env vars (inherited from process.env).
 */
const FAKE_KEPUBIFY = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
if (process.env.FAKE_KEPUBIFY_LOG) fs.appendFileSync(process.env.FAKE_KEPUBIFY_LOG, JSON.stringify(args) + '\\n')
const mode = process.env.FAKE_KEPUBIFY_MODE || 'ok'
setTimeout(() => {
  if (mode === 'fail') {
    console.error('Error: conversion failed')
    process.exit(1)
  }
  if (mode === 'hang') return setInterval(() => {}, 1000)
  const base = path.basename(args[0]).replace(/\\.epub$/i, '')
  fs.writeFileSync(path.join(args[args.indexOf('-o') + 1], base + '.kepub.epub'), 'KEPUB:' + fs.readFileSync(args[0], 'utf8'))
}, Number(process.env.FAKE_KEPUBIFY_DELAY_MS || 0))
`

describe('KepubManager', () => {
  let tempDir
  let libDir
  let logPath

  const ITEM_ID = '11111111-1111-4111-8111-111111111111'
  const ITEM_ID_2 = '22222222-2222-4222-8222-222222222222'

  const makeItem = (id, filePath) => ({ id, media: { ebookFile: { ebookFormat: 'epub', metadata: { path: filePath } } } })
  const cacheFiles = () => nodeFs.readdirSync(CacheManager.KepubCachePath)

  function writeSource(name, content) {
    const filePath = Path.join(libDir, name)
    nodeFs.mkdirSync(Path.dirname(filePath), { recursive: true })
    nodeFs.writeFileSync(filePath, content)
    return filePath
  }

  function conversionCount() {
    return nodeFs.existsSync(logPath) ? nodeFs.readFileSync(logPath, 'utf8').trim().split('\n').length : 0
  }

  function writeEpub(name, entries) {
    const file = Path.join(libDir, name)
    return new Promise((resolve, reject) => {
      const output = nodeFs.createWriteStream(file)
      const archive = archiver('zip')
      output.on('close', () => resolve(file))
      archive.on('error', reject)
      archive.pipe(output)
      for (const [entryName, content] of Object.entries(entries)) archive.append(content, { name: entryName })
      archive.finalize()
    })
  }

  beforeEach(() => {
    tempDir = nodeFs.mkdtempSync(Path.join(os.tmpdir(), 'kepub-test-'))
    libDir = Path.join(tempDir, 'library')
    logPath = Path.join(tempDir, 'kepubify.log')
    CacheManager.KepubCachePath = Path.join(tempDir, 'cache', 'kepub')
    nodeFs.mkdirSync(libDir)
    nodeFs.mkdirSync(CacheManager.KepubCachePath, { recursive: true })

    const kepubifyPath = Path.join(tempDir, 'kepubify')
    nodeFs.writeFileSync(kepubifyPath, FAKE_KEPUBIFY, { mode: 0o755 })

    process.env.KEPUBIFY_PATH = kepubifyPath
    process.env.FAKE_KEPUBIFY_LOG = logPath

    KepubManager.available = null
    KepubManager.conversionTimeoutMs = 120 * 1000

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(() => {
    sinon.restore()
    for (const key of ['KEPUBIFY_PATH', 'FAKE_KEPUBIFY_LOG', 'FAKE_KEPUBIFY_MODE', 'FAKE_KEPUBIFY_DELAY_MS']) delete process.env[key]
    KepubManager.available = null
    nodeFs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('getKepubPath', () => {
    it('converts once, caches by item id and mtime, and reuses the cache', async () => {
      const src = writeSource('Book [1].epub', 'book one')
      const kepubPath = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))

      expect(kepubPath).to.equal(Path.join(CacheManager.KepubCachePath, `${ITEM_ID}-${Math.floor(nodeFs.statSync(src).mtimeMs)}.kepub.epub`))
      expect(nodeFs.readFileSync(kepubPath, 'utf8')).to.equal('KEPUB:book one')
      const [source, outputFlag, , noSuffixFlag] = JSON.parse(nodeFs.readFileSync(logPath, 'utf8'))
      expect([source, outputFlag, noSuffixFlag]).to.deep.equal([src, '-o', '-i'])

      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.equal(kepubPath)
      expect(await KepubManager.getCachedKepubPath(makeItem(ITEM_ID, src))).to.equal(kepubPath)
      expect(conversionCount()).to.equal(1)
      // the temp dir is gone
      expect(cacheFiles()).to.deep.equal([Path.basename(kepubPath)])
    })

    it('reconverts when the ebook changes and drops the old conversion', async () => {
      const src = writeSource('book.epub', 'version 1')
      const first = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))

      nodeFs.writeFileSync(src, 'version 2')
      const newTime = new Date(Date.now() + 60000)
      nodeFs.utimesSync(src, newTime, newTime)

      const second = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))
      expect(second).to.not.equal(first)
      expect(nodeFs.readFileSync(second, 'utf8')).to.equal('KEPUB:version 2')
      expect(cacheFiles()).to.deep.equal([Path.basename(second)])
      expect(conversionCount()).to.equal(2)
    })

    it('returns a .kepub.epub source as it is', async () => {
      const src = writeSource('book.kepub.epub', 'already kepub')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.equal(src)
      expect(await KepubManager.getCachedKepubPath(makeItem(ITEM_ID, src))).to.equal(src)
      expect(conversionCount()).to.equal(0)
    })

    it('converts only once for concurrent calls', async () => {
      process.env.FAKE_KEPUBIFY_DELAY_MS = '300'
      const item = makeItem(ITEM_ID, writeSource('book.epub', 'book'))
      const results = await Promise.all([KepubManager.getKepubPath(item), KepubManager.getKepubPath(item), KepubManager.getKepubPath(item)])
      expect(results[0]).to.be.a('string')
      expect(results).to.deep.equal([results[0], results[0], results[0]])
      expect(conversionCount()).to.equal(1)
      expect(KepubManager.inFlight.size).to.equal(0)
    })

    it('keeps concurrent conversions of same-named books apart', async () => {
      process.env.FAKE_KEPUBIFY_DELAY_MS = '100'
      const srcA = writeSource('a/book.epub', 'book A')
      const srcB = writeSource('b/book.epub', 'book B')
      const [pathA, pathB] = await Promise.all([KepubManager.getKepubPath(makeItem(ITEM_ID, srcA)), KepubManager.getKepubPath(makeItem(ITEM_ID_2, srcB))])
      expect(nodeFs.readFileSync(pathA, 'utf8')).to.equal('KEPUB:book A')
      expect(nodeFs.readFileSync(pathB, 'utf8')).to.equal('KEPUB:book B')
    })

    it('returns null and caches nothing when kepubify fails, then retries', async () => {
      process.env.FAKE_KEPUBIFY_MODE = 'fail'
      const src = writeSource('book.epub', 'book')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.equal(null)
      expect(cacheFiles()).to.deep.equal([])
      expect(Logger.error.calledWithMatch(/kepubify exited with code 1/)).to.equal(true)

      delete process.env.FAKE_KEPUBIFY_MODE
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.be.a('string')
    })

    it('kills kepubify and returns null on timeout', async () => {
      process.env.FAKE_KEPUBIFY_MODE = 'hang'
      KepubManager.conversionTimeoutMs = 300
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, writeSource('book.epub', 'book')))).to.equal(null)
      expect(Logger.error.calledWithMatch(/timed out/)).to.equal(true)
      expect(cacheFiles()).to.deep.equal([])
    })
  })

  describe('getEpubLayout', () => {
    it('detects fixed-layout epubs', async () => {
      const fixed = await writeEpub('fixed.epub', { 'META-INF/container.xml': CONTAINER_XML, 'OEBPS/content.opf': opf('<meta property="rendition:layout">pre-paginated</meta>') })
      expect(await KepubManager.getEpubLayout(fixed)).to.equal('pre-paginated')
      const reflowable = await writeEpub('reflow.epub', { 'META-INF/container.xml': CONTAINER_XML, 'OEBPS/content.opf': opf('<meta property="rendition:layout">reflowable</meta>') })
      expect(await KepubManager.getEpubLayout(reflowable)).to.equal(null)
    })

    it('treats unreadable epubs as reflowable', async () => {
      expect(await KepubManager.getEpubLayout(writeSource('notzip.epub', 'not a zip'))).to.equal(null)
      const noOpf = await writeEpub('noopf.epub', { 'META-INF/container.xml': CONTAINER_XML })
      expect(await KepubManager.getEpubLayout(noOpf)).to.equal(null)
    })
  })
})
