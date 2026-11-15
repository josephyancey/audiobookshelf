const Path = require('path')
const { execFile } = require('child_process')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const CacheManager = require('./CacheManager')
const { extractXmlToJson } = require('../utils/parsers/parseEpubMetadata')

/**
 * On-demand EPUB -> KEPUB conversion with kepubify (KEPUBIFY_PATH), cached as
 * `<KepubCachePath>/<libraryItemId>-<ebook mtimeMs>.kepub.epub`.
 * Conversion only happens when a kepub is downloaded, never during sync.
 */
class KepubManager {
  constructor() {
    /** Kill kepubify after this long */
    this.conversionTimeoutMs = 120 * 1000

    /** @type {Map<string, Promise<string|null>>} cache path -> in-flight conversion */
    this.inFlight = new Map()

    /** @type {boolean|null} whether kepubify exists, checked once */
    this.available = null
  }

  get kepubifyPath() {
    return process.env.KEPUBIFY_PATH || null
  }

  /**
   * Whether KEPUBIFY_PATH points at a file. Checked once.
   *
   * @returns {boolean}
   */
  isAvailable() {
    if (this.available === null) {
      const kepubifyPath = this.kepubifyPath
      this.available = !!kepubifyPath && !!fs.statSync(kepubifyPath, { throwIfNoEntry: false })?.isFile()
      if (kepubifyPath && !this.available) Logger.warn(`[KepubManager] kepubify not found at "${kepubifyPath}"`)
    }
    return this.available
  }

  /**
   * ABS scans a kepub as an epub, so it is recognised by its `.kepub.epub` file name
   *
   * @param {import('../models/Book').EBookFileObject} ebookFile
   * @returns {boolean}
   */
  isKepub(ebookFile) {
    return /\.kepub\.epub$/i.test(ebookFile?.metadata?.path || '')
  }

  /**
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<string>}
   */
  async getCachePath(libraryItem) {
    const { mtimeMs } = await fs.stat(libraryItem.media.ebookFile.metadata.path)
    return Path.join(CacheManager.KepubCachePath, `${libraryItem.id}-${Math.floor(mtimeMs)}.kepub.epub`)
  }

  /**
   * The kepub for an item if it already exists, without converting
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<string|null>}
   */
  async getCachedKepubPath(libraryItem) {
    const ebookFile = libraryItem?.media?.ebookFile
    if (!ebookFile?.metadata?.path) return null
    if (this.isKepub(ebookFile)) return ebookFile.metadata.path
    const cachePath = await this.getCachePath(libraryItem).catch(() => null)
    return cachePath && (await fs.pathExists(cachePath)) ? cachePath : null
  }

  /**
   * The kepub for an item's ebook, converting on demand. A kepub source is returned as-is.
   * Null on any failure (the caller serves the epub).
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<string|null>}
   */
  async getKepubPath(libraryItem) {
    const ebookFile = libraryItem?.media?.ebookFile
    if (!ebookFile?.metadata?.path || ebookFile.ebookFormat !== 'epub') return null
    if (this.isKepub(ebookFile)) return ebookFile.metadata.path

    let cachePath
    try {
      cachePath = await this.getCachePath(libraryItem)
    } catch (error) {
      Logger.error(`[KepubManager] Ebook file not found at "${ebookFile.metadata.path}": ${error.message}`)
      return null
    }
    if (await fs.pathExists(cachePath)) return cachePath
    if (!this.isAvailable()) return null

    if (!this.inFlight.has(cachePath)) {
      const promise = this.convert(libraryItem.id, ebookFile.metadata.path, cachePath).finally(() => this.inFlight.delete(cachePath))
      this.inFlight.set(cachePath, promise)
    }
    return this.inFlight.get(cachePath)
  }

  /**
   * Run kepubify into a unique temp dir (shared names served the wrong book, Calibre-Web-Automated 7536a81)
   * and move the output into the cache in place of older conversions of the item.
   *
   * @param {string} libraryItemId
   * @param {string} sourcePath
   * @param {string} cachePath
   * @returns {Promise<string|null>} cachePath on success
   */
  async convert(libraryItemId, sourcePath, cachePath) {
    let tempDir = null
    try {
      tempDir = await fs.mkdtemp(Path.join(CacheManager.KepubCachePath, '.tmp-'))
      Logger.info(`[KepubManager] Converting "${sourcePath}" to kepub`)
      await this.runKepubify(sourcePath, tempDir)
      const outputs = (await fs.readdir(tempDir)).filter((name) => name.endsWith('.kepub.epub'))
      if (outputs.length !== 1) throw new Error(`expected one kepub, kepubify wrote ${outputs.length}`)
      await CacheManager.purgeEntityCache(libraryItemId, CacheManager.KepubCachePath)
      await fs.rename(Path.join(tempDir, outputs[0]), cachePath)
      return cachePath
    } catch (error) {
      Logger.error(`[KepubManager] Failed to convert "${sourcePath}" to kepub: ${error.message}`)
      return null
    } finally {
      if (tempDir) await fs.remove(tempDir).catch(() => {})
    }
  }

  /**
   * `kepubify <src> -o <dir> -i` writes `<dir>/<src name>.kepub.epub` (-i: no "_converted" suffix)
   *
   * @param {string} sourcePath
   * @param {string} outputDir
   * @returns {Promise<void>}
   */
  runKepubify(sourcePath, outputDir) {
    return new Promise((resolve, reject) => {
      execFile(this.kepubifyPath, [sourcePath, '-o', outputDir, '-i'], { timeout: this.conversionTimeoutMs, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout, stderr) => {
        if (error?.killed) return reject(new Error(`kepubify timed out after ${this.conversionTimeoutMs}ms`))
        if (error) return reject(new Error(`kepubify exited with code ${error.code}: ${`${stderr}${stdout}`.trim()}`))
        resolve()
      })
    })
  }

  /**
   * Fixed-layout epubs must be advertised as EPUB3FL (Calibre-Web 4eaa9413)
   *
   * @param {string} ebookPath
   * @returns {Promise<'pre-paginated'|null>} null for reflowable or unreadable
   */
  async getEpubLayout(ebookPath) {
    const containerJson = await extractXmlToJson(ebookPath, 'META-INF/container.xml')
    const packageDocPath = containerJson?.container?.rootfiles?.[0]?.rootfile?.[0]?.$?.['full-path']
    const packageJson = packageDocPath ? await extractXmlToJson(ebookPath, packageDocPath) : null
    const metas = packageJson?.package?.metadata?.[0]?.meta || []
    const isFixed = metas.some((meta) => meta?.$?.property === 'rendition:layout' && String(meta._).trim() === 'pre-paginated')
    return isFixed ? 'pre-paginated' : null
  }
}
module.exports = new KepubManager()
