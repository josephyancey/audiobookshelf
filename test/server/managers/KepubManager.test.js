const chai = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const nodeFs = require('fs')
const zlib = require('zlib')
const Logger = require('../../../server/Logger')
const KepubManager = require('../../../server/managers/KepubManager')

const expect = chai.expect

/**
 * Build a zip with stored (uncompressed) entries
 *
 * @param {{name: string, data: string|Buffer}[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = zlib.crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + data.length
  }
  const centralDir = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDir, end])
}

const CONTAINER_XML = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'

function opf(metadataExtra = '') {
  return `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>T</dc:title>${metadataExtra}</metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`
}

function writeEpub(filePath, opfContent, containerXml = CONTAINER_XML) {
  const entries = [{ name: 'mimetype', data: 'application/epub+zip' }]
  if (containerXml !== null) entries.push({ name: 'META-INF/container.xml', data: containerXml })
  if (opfContent !== null) entries.push({ name: 'OEBPS/content.opf', data: opfContent })
  entries.push({ name: 'OEBPS/c1.xhtml', data: '<html><body><p>Hi</p></body></html>' })
  nodeFs.writeFileSync(filePath, buildZip(entries))
  return filePath
}

/**
 * Fake kepubify: `kepubify <src> -o <dir> -i` writes `<dir>/<basename>.kepub.epub` containing "KEPUB:" + source content.
 * Behavior is controlled by env vars (inherited from process.env).
 */
const FAKE_KEPUBIFY = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const src = args[0]
const outDir = args[args.indexOf('-o') + 1]
if (process.env.FAKE_KEPUBIFY_LOG) fs.appendFileSync(process.env.FAKE_KEPUBIFY_LOG, JSON.stringify(args) + '\\n')
const mode = process.env.FAKE_KEPUBIFY_MODE || 'ok'
setTimeout(() => {
  if (mode === 'fail') {
    console.error('Error: conversion failed')
    process.exit(1)
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000)
    return
  }
  if (mode === 'none') process.exit(0)
  const base = path.basename(src).replace(/\\.epub$/i, '')
  fs.writeFileSync(path.join(outDir, base + '.kepub.epub'), 'KEPUB:' + fs.readFileSync(src, 'utf8'))
  if (mode === 'two') fs.writeFileSync(path.join(outDir, 'other.kepub.epub'), 'other')
  process.exit(0)
}, Number(process.env.FAKE_KEPUBIFY_DELAY_MS || 0))
`

describe('KepubManager', () => {
  let tempDir
  let metadataPath
  let binDir
  let libDir
  let logPath
  let originalMetadataPath
  let originalEnv

  const ITEM_ID = '11111111-1111-4111-8111-111111111111'
  const ITEM_ID_2 = '22222222-2222-4222-8222-222222222222'

  function makeItem(id, filePath, ebookFormat = 'epub') {
    return { id, media: { ebookFile: { ebookFormat, metadata: { path: filePath } } } }
  }

  function writeSource(name, content) {
    const filePath = Path.join(libDir, name)
    nodeFs.writeFileSync(filePath, content)
    return filePath
  }

  function conversionCount() {
    if (!nodeFs.existsSync(logPath)) return 0
    return nodeFs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length
  }

  function cacheDir() {
    return Path.join(metadataPath, 'cache', 'kepub')
  }

  beforeEach(() => {
    tempDir = nodeFs.mkdtempSync(Path.join(os.tmpdir(), 'kepub-test-'))
    metadataPath = Path.join(tempDir, 'metadata')
    binDir = Path.join(tempDir, 'bin')
    libDir = Path.join(tempDir, 'library')
    nodeFs.mkdirSync(metadataPath)
    nodeFs.mkdirSync(binDir)
    nodeFs.mkdirSync(libDir)
    logPath = Path.join(tempDir, 'kepubify.log')

    const kepubifyPath = Path.join(binDir, 'kepubify')
    nodeFs.writeFileSync(kepubifyPath, FAKE_KEPUBIFY)
    nodeFs.chmodSync(kepubifyPath, 0o755)

    originalMetadataPath = global.MetadataPath
    originalEnv = { ...process.env }
    global.MetadataPath = metadataPath
    process.env.KEPUBIFY_PATH = kepubifyPath
    process.env.FAKE_KEPUBIFY_LOG = logPath
    delete process.env.FAKE_KEPUBIFY_MODE
    delete process.env.FAKE_KEPUBIFY_DELAY_MS

    KepubManager.availabilityCache = null
    KepubManager.inFlight.clear()
    KepubManager.conversionTimeoutMs = 120 * 1000

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(() => {
    sinon.restore()
    global.MetadataPath = originalMetadataPath
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    KepubManager.availabilityCache = null
    KepubManager.conversionTimeoutMs = 120 * 1000
    nodeFs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('isAvailable', () => {
    it('should be false when KEPUBIFY_PATH is not set', () => {
      delete process.env.KEPUBIFY_PATH
      expect(KepubManager.isAvailable()).to.be.false
    })

    it('should be false when the binary does not exist', () => {
      process.env.KEPUBIFY_PATH = Path.join(binDir, 'missing')
      expect(KepubManager.isAvailable()).to.be.false
    })

    it('should be true when the binary exists and cache the check', () => {
      expect(KepubManager.isAvailable()).to.be.true
      // cached: removing the binary is not noticed until the configured path changes
      nodeFs.rmSync(process.env.KEPUBIFY_PATH)
      expect(KepubManager.isAvailable()).to.be.true
      process.env.KEPUBIFY_PATH = Path.join(binDir, 'other')
      expect(KepubManager.isAvailable()).to.be.false
    })
  })

  describe('getKepubPath', () => {
    it('should convert, cache by item id and mtime, and reuse the cache', async () => {
      const src = writeSource('Book [1].epub', 'book one')
      const mtimeMs = Math.floor(nodeFs.statSync(src).mtimeMs)

      const kepubPath = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))

      expect(kepubPath).to.equal(Path.join(cacheDir(), `${ITEM_ID}-${mtimeMs}.kepub.epub`))
      expect(nodeFs.readFileSync(kepubPath, 'utf8')).to.equal('KEPUB:book one')
      expect(conversionCount()).to.equal(1)

      const args = JSON.parse(nodeFs.readFileSync(logPath, 'utf8').trim())
      expect(args[0]).to.equal(src)
      expect(args.slice(1, 2)).to.deep.equal(['-o'])
      expect(args[3]).to.equal('-i')

      const again = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))
      expect(again).to.equal(kepubPath)
      expect(conversionCount()).to.equal(1)

      // temp dirs are removed
      expect(nodeFs.readdirSync(cacheDir())).to.deep.equal([Path.basename(kepubPath)])
    })

    it('should reconvert when the ebook mtime changes', async () => {
      const src = writeSource('book.epub', 'version 1')
      const first = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))

      nodeFs.writeFileSync(src, 'version 2')
      const newTime = new Date(Date.now() + 60000)
      nodeFs.utimesSync(src, newTime, newTime)

      const second = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))
      expect(second).to.not.equal(first)
      expect(second).to.equal(Path.join(cacheDir(), `${ITEM_ID}-${Math.floor(nodeFs.statSync(src).mtimeMs)}.kepub.epub`))
      expect(nodeFs.readFileSync(second, 'utf8')).to.equal('KEPUB:version 2')
      expect(conversionCount()).to.equal(2)
    })

    it('should return the source path for a kepub source', async () => {
      const src = writeSource('book.kepub.epub', 'already kepub')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.equal(src)

      const src2 = writeSource('book2.epub', 'flagged kepub')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID_2, src2, 'kepub'))).to.equal(src2)
      expect(conversionCount()).to.equal(0)
    })

    it('should return null for non-epub ebooks and items without an ebook', async () => {
      const src = writeSource('book.pdf', 'pdf')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src, 'pdf'))).to.be.null
      expect(await KepubManager.getKepubPath({ id: ITEM_ID, media: { ebookFile: null } })).to.be.null
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, Path.join(libDir, 'missing.epub')))).to.be.null
      expect(conversionCount()).to.equal(0)
    })

    it('should return null when kepubify is not available', async () => {
      process.env.KEPUBIFY_PATH = Path.join(binDir, 'missing')
      const src = writeSource('book.epub', 'book')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.be.null
    })

    it('should convert only once for concurrent calls', async () => {
      process.env.FAKE_KEPUBIFY_DELAY_MS = '300'
      const src = writeSource('book.epub', 'book')
      const item = makeItem(ITEM_ID, src)

      const results = await Promise.all([KepubManager.getKepubPath(item), KepubManager.getKepubPath(item), KepubManager.getKepubPath(item)])

      expect(results[0]).to.be.a('string')
      expect(results[1]).to.equal(results[0])
      expect(results[2]).to.equal(results[0])
      expect(conversionCount()).to.equal(1)
      expect(KepubManager.inFlight.size).to.equal(0)
    })

    it('should keep concurrent conversions of different books apart', async () => {
      process.env.FAKE_KEPUBIFY_DELAY_MS = '100'
      // Same file name in different folders: output names collide unless temp dirs are unique
      nodeFs.mkdirSync(Path.join(libDir, 'a'))
      nodeFs.mkdirSync(Path.join(libDir, 'b'))
      const srcA = writeSource('a/book.epub', 'book A')
      const srcB = writeSource('b/book.epub', 'book B')

      const [pathA, pathB] = await Promise.all([KepubManager.getKepubPath(makeItem(ITEM_ID, srcA)), KepubManager.getKepubPath(makeItem(ITEM_ID_2, srcB))])

      expect(nodeFs.readFileSync(pathA, 'utf8')).to.equal('KEPUB:book A')
      expect(nodeFs.readFileSync(pathB, 'utf8')).to.equal('KEPUB:book B')
      expect(conversionCount()).to.equal(2)
    })

    it('should return null and not cache on kepubify failure', async () => {
      process.env.FAKE_KEPUBIFY_MODE = 'fail'
      const src = writeSource('book.epub', 'book')

      const results = await Promise.all([KepubManager.getKepubPath(makeItem(ITEM_ID, src)), KepubManager.getKepubPath(makeItem(ITEM_ID, src))])

      expect(results).to.deep.equal([null, null])
      expect(conversionCount()).to.equal(1)
      expect(nodeFs.readdirSync(cacheDir())).to.deep.equal([])
      expect(Logger.error.calledWithMatch(/kepubify exited with code 1/)).to.be.true

      // next request retries
      delete process.env.FAKE_KEPUBIFY_MODE
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.be.a('string')
      expect(conversionCount()).to.equal(2)
    })

    it('should return null when kepubify produces no output', async () => {
      process.env.FAKE_KEPUBIFY_MODE = 'none'
      const src = writeSource('book.epub', 'book')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.be.null
      expect(nodeFs.readdirSync(cacheDir())).to.deep.equal([])
    })

    it('should return null when kepubify produces more than one output', async () => {
      process.env.FAKE_KEPUBIFY_MODE = 'two'
      const src = writeSource('book.epub', 'book')
      expect(await KepubManager.getKepubPath(makeItem(ITEM_ID, src))).to.be.null
      expect(nodeFs.readdirSync(cacheDir())).to.deep.equal([])
    })

    it('should kill kepubify and return null on timeout', async () => {
      process.env.FAKE_KEPUBIFY_MODE = 'hang'
      KepubManager.conversionTimeoutMs = 300
      const src = writeSource('book.epub', 'book')

      const start = Date.now()
      const result = await KepubManager.getKepubPath(makeItem(ITEM_ID, src))

      expect(result).to.be.null
      expect(Date.now() - start).to.be.below(5000)
      expect(Logger.error.calledWithMatch(/timed out/)).to.be.true
      expect(nodeFs.readdirSync(cacheDir())).to.deep.equal([])
    })
  })

  describe('getEpubLayout', () => {
    it('should return null for a reflowable epub', async () => {
      const epub = writeEpub(Path.join(libDir, 'reflow.epub'), opf('<meta property="rendition:layout">reflowable</meta>'))
      expect(await KepubManager.getEpubLayout(epub)).to.be.null

      const plain = writeEpub(Path.join(libDir, 'plain.epub'), opf())
      expect(await KepubManager.getEpubLayout(plain)).to.be.null
    })

    it('should return pre-paginated for a fixed-layout epub', async () => {
      const epub = writeEpub(Path.join(libDir, 'fixed.epub'), opf('<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">landscape</meta>'))
      expect(await KepubManager.getEpubLayout(epub)).to.equal('pre-paginated')
    })

    it('should handle a BOM, prefixed OPF tags and the name/content form', async () => {
      const prefixedOpf = '﻿<?xml version="1.0" encoding="utf-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0"><opf:metadata><opf:meta name="rendition:layout" content="pre-paginated"/></opf:metadata></opf:package>'
      const epub = writeEpub(Path.join(libDir, 'prefixed.epub'), prefixedOpf, '﻿' + CONTAINER_XML)
      expect(await KepubManager.getEpubLayout(epub)).to.equal('pre-paginated')
    })

    it('should return null for broken epubs', async () => {
      const notZip = writeSource('notzip.epub', 'this is not a zip')
      expect(await KepubManager.getEpubLayout(notZip)).to.be.null

      const noContainer = writeEpub(Path.join(libDir, 'nocontainer.epub'), opf('<meta property="rendition:layout">pre-paginated</meta>'), null)
      expect(await KepubManager.getEpubLayout(noContainer)).to.be.null

      const noOpf = writeEpub(Path.join(libDir, 'noopf.epub'), null)
      expect(await KepubManager.getEpubLayout(noOpf)).to.be.null

      const badXml = writeEpub(Path.join(libDir, 'badxml.epub'), '<package><metadata><meta property="rendition:layout">pre-paginated</meta>')
      expect(await KepubManager.getEpubLayout(badXml)).to.be.null

      const badContainer = writeEpub(Path.join(libDir, 'badcontainer.epub'), opf(), '<container><rootfiles></container>')
      expect(await KepubManager.getEpubLayout(badContainer)).to.be.null

      expect(await KepubManager.getEpubLayout(Path.join(libDir, 'missing.epub'))).to.be.null
    })
  })

  describe('cleanup', () => {
    it('should remove files of deleted items, older versions and stale temp dirs', async () => {
      const dir = cacheDir()
      nodeFs.mkdirSync(dir, { recursive: true })
      const files = [`${ITEM_ID}-1000.kepub.epub`, `${ITEM_ID}-2000.kepub.epub`, `${ITEM_ID_2}-1000.kepub.epub`, 'unrelated.txt']
      for (const file of files) nodeFs.writeFileSync(Path.join(dir, file), 'x')
      nodeFs.mkdirSync(Path.join(dir, '.tmp-old'))
      nodeFs.mkdirSync(Path.join(dir, '.tmp-new'))
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      nodeFs.utimesSync(Path.join(dir, '.tmp-old'), old, old)

      const existingStub = sinon.stub(KepubManager, 'getExistingLibraryItemIds').resolves(new Set([ITEM_ID]))

      const removed = await KepubManager.cleanup()

      expect(existingStub.calledOnce).to.be.true
      expect(existingStub.firstCall.args[0]).to.have.members([ITEM_ID, ITEM_ID_2])
      expect(removed).to.equal(3)
      expect(nodeFs.readdirSync(dir).sort()).to.deep.equal(['.tmp-new', `${ITEM_ID}-2000.kepub.epub`, 'unrelated.txt'].sort())
    })

    it('should do nothing when the cache dir does not exist', async () => {
      expect(await KepubManager.cleanup()).to.equal(0)
    })
  })
})
