const Path = require('path')
const { execFile } = require('child_process')
const xml2js = require('xml2js')
const fs = require('../libs/fsExtra')
const StreamZip = require('../libs/nodeStreamZip')
const Logger = require('../Logger')
const Database = require('../Database')

/**
 * Cache file name: `<libraryItemId>-<ebook mtimeMs>.kepub.epub`
 * libraryItemId is a uuid (contains dashes) so the mtime is matched as the last dash-separated number
 */
const CACHE_FILE_REGEX = /^(.+)-(\d+)\.kepub\.epub$/
const TEMP_DIR_PREFIX = '.tmp-'

/**
 * On-demand EPUB -> KEPUB conversion with kepubify, cached in `<metadata>/cache/kepub`.
 * Conversion only ever happens when a kepub is requested (download), never during sync.
 */
class KepubManager {
  constructor() {
    /** Kill kepubify after this long */
    this.conversionTimeoutMs = 120 * 1000
    /** Leftover temp dirs older than this are removed by cleanup() */
    this.staleTempDirMs = 60 * 60 * 1000

    /** @type {Map<string, { cachePath: string, promise: Promise<string|null> }>} libraryItemId -> in-flight conversion */
    this.inFlight = new Map()

    /** @type {{ path: string, available: boolean }} */
    this.availabilityCache = null
  }

  get kepubifyPath() {
    return process.env.KEPUBIFY_PATH || null
  }

  get cachePath() {
    return Path.join(global.MetadataPath, 'cache', 'kepub')
  }

  /**
   * Whether a kepubify binary is configured (KEPUBIFY_PATH set and the file exists).
   * The check is cached per configured path.
   *
   * @returns {boolean}
   */
  isAvailable() {
    const kepubifyPath = this.kepubifyPath
    if (!kepubifyPath) return false
    if (this.availabilityCache?.path !== kepubifyPath) {
      let available = false
      try {
        available = fs.statSync(kepubifyPath).isFile()
      } catch {
        available = false
      }
      if (!available) Logger.warn(`[KepubManager] kepubify not found at "${kepubifyPath}"`)
      this.availabilityCache = { path: kepubifyPath, available }
    }
    return this.availabilityCache.available
  }

  /**
   * @param {string} filePath
   * @param {string} [ebookFormat]
   * @returns {boolean}
   */
  isKepub(filePath, ebookFormat) {
    return ebookFormat === 'kepub' || filePath.toLowerCase().endsWith('.kepub.epub') || filePath.toLowerCase().endsWith('.kepub')
  }

  /**
   * The kepub for an item if it already exists, without converting
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<string|null>}
   */
  async getCachedKepubPath(libraryItem) {
    const ebookFile = libraryItem?.media?.ebookFile
    const sourcePath = ebookFile?.metadata?.path
    if (!libraryItem?.id || !sourcePath) return null
    if (this.isKepub(sourcePath, ebookFile.ebookFormat)) return sourcePath
    try {
      const sourceStat = await fs.stat(sourcePath)
      const cachePath = Path.join(this.cachePath, `${libraryItem.id}-${Math.floor(sourceStat.mtimeMs)}.kepub.epub`)
      return (await fs.pathExists(cachePath)) ? cachePath : null
    } catch {
      return null
    }
  }

  /**
   * Get the absolute path of a kepub for the library item's ebook, converting on demand.
   * A kepub source is returned as-is. Returns null on any failure (caller serves the epub).
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<string|null>}
   */
  async getKepubPath(libraryItem) {
    const libraryItemId = libraryItem?.id
    const ebookFile = libraryItem?.media?.ebookFile
    const sourcePath = ebookFile?.metadata?.path
    if (!libraryItemId || !sourcePath) {
      Logger.warn(`[KepubManager] getKepubPath: library item "${libraryItemId}" has no ebook file`)
      return null
    }

    if (this.isKepub(sourcePath, ebookFile.ebookFormat)) {
      return sourcePath
    }

    const ext = Path.extname(sourcePath).toLowerCase()
    if (ebookFile.ebookFormat !== 'epub' && ext !== '.epub') {
      Logger.debug(`[KepubManager] getKepubPath: ebook "${sourcePath}" is not an epub`)
      return null
    }

    let sourceStat
    try {
      sourceStat = await fs.stat(sourcePath)
    } catch (error) {
      Logger.error(`[KepubManager] getKepubPath: ebook file not found at "${sourcePath}"`, error.message)
      return null
    }

    const cachePath = Path.join(this.cachePath, `${libraryItemId}-${Math.floor(sourceStat.mtimeMs)}.kepub.epub`)
    if (await fs.pathExists(cachePath)) return cachePath

    if (!this.isAvailable()) {
      Logger.debug('[KepubManager] getKepubPath: kepubify not available')
      return null
    }

    // One conversion per item at a time
    let inFlight = this.inFlight.get(libraryItemId)
    while (inFlight) {
      if (inFlight.cachePath === cachePath) return inFlight.promise
      // Conversion of an older version of the ebook is running, wait for it then convert this one
      await inFlight.promise
      if (await fs.pathExists(cachePath)) return cachePath
      inFlight = this.inFlight.get(libraryItemId)
    }

    const promise = this.convert(sourcePath, cachePath).finally(() => {
      if (this.inFlight.get(libraryItemId)?.promise === promise) {
        this.inFlight.delete(libraryItemId)
      }
    })
    this.inFlight.set(libraryItemId, { cachePath, promise })
    return promise
  }

  /**
   * Run kepubify into a unique temp dir and move the single output into the cache.
   *
   * @param {string} sourcePath
   * @param {string} cachePath
   * @returns {Promise<string|null>} cachePath on success
   */
  async convert(sourcePath, cachePath) {
    let tempDir = null
    const startTime = Date.now()
    try {
      await fs.ensureDir(this.cachePath)
      // Unique temp dir per conversion, inside the cache dir so the final rename is atomic
      tempDir = await fs.mkdtemp(Path.join(this.cachePath, TEMP_DIR_PREFIX))

      Logger.info(`[KepubManager] Converting "${sourcePath}" to kepub`)
      await this.runKepubify(sourcePath, tempDir)

      const outputFiles = (await fs.readdir(tempDir)).filter((name) => name.toLowerCase().endsWith('.kepub.epub'))
      if (outputFiles.length !== 1) {
        Logger.error(`[KepubManager] Expected exactly one kepub output for "${sourcePath}", found ${outputFiles.length}`)
        return null
      }

      const outputPath = Path.join(tempDir, outputFiles[0])
      await fs.chmod(outputPath, 0o644).catch(() => {})
      await fs.rename(outputPath, cachePath)

      Logger.info(`[KepubManager] Converted "${sourcePath}" to kepub in ${Date.now() - startTime}ms`)
      return cachePath
    } catch (error) {
      Logger.error(`[KepubManager] Failed to convert "${sourcePath}" to kepub: ${error.message}`)
      return null
    } finally {
      if (tempDir) {
        await fs.remove(tempDir).catch((error) => {
          Logger.error(`[KepubManager] Failed to remove temp dir "${tempDir}"`, error)
        })
      }
    }
  }

  /**
   * `kepubify <src> -o <dir> -i` writes `<dir>/<src basename>.kepub.epub`
   * (-i: no "_converted" suffix). Killed after conversionTimeoutMs.
   *
   * @param {string} sourcePath
   * @param {string} outputDir
   * @returns {Promise<void>}
   */
  runKepubify(sourcePath, outputDir) {
    return new Promise((resolve, reject) => {
      execFile(this.kepubifyPath, [sourcePath, '-o', outputDir, '-i'], { timeout: this.conversionTimeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            return reject(new Error(`kepubify timed out after ${this.conversionTimeoutMs}ms`))
          }
          const output = `${stderr || ''}${stdout || ''}`.trim()
          return reject(new Error(`kepubify exited with code ${error.code}${output ? `: ${output}` : ''}`))
        }
        Logger.debug(`[KepubManager] kepubify output: ${stdout}`)
        resolve()
      })
    })
  }

  /**
   * Read rendition:layout from the epub's OPF.
   * Any error (missing files, bad XML, not a zip) returns null, i.e. reflowable.
   *
   * @param {string} ebookPath
   * @returns {Promise<'pre-paginated'|null>}
   */
  async getEpubLayout(ebookPath) {
    let zip = null
    try {
      zip = new StreamZip.async({ file: ebookPath })

      const containerJson = await this.parseXml(await this.readZipText(zip, 'META-INF/container.xml'))
      const rootfiles = containerJson?.container?.rootfiles?.[0]?.rootfile || []
      const rootfile = rootfiles.find((rf) => rf?.$?.['media-type'] === 'application/oebps-package+xml') || rootfiles[0]
      const opfPath = rootfile?.$?.['full-path']
      if (!opfPath) return null

      const opfJson = await this.parseXml(await this.readZipText(zip, opfPath))
      const metadata = opfJson?.package?.metadata?.[0]
      const metas = Array.isArray(metadata?.meta) ? metadata.meta : []
      for (const meta of metas) {
        if (!meta || typeof meta !== 'object') continue
        const attrs = meta.$ || {}
        // EPUB 3: <meta property="rendition:layout">pre-paginated</meta>
        // EPUB 2 style: <meta name="rendition:layout" content="pre-paginated"/>
        const value = attrs.property === 'rendition:layout' ? meta._ : attrs.name === 'rendition:layout' ? attrs.content : null
        if (typeof value === 'string' && value.trim() === 'pre-paginated') return 'pre-paginated'
      }
      return null
    } catch (error) {
      Logger.debug(`[KepubManager] getEpubLayout: failed to read layout of "${ebookPath}": ${error.message}`)
      return null
    } finally {
      if (zip) await zip.close().catch(() => {})
    }
  }

  /**
   * @param {*} zip StreamZip.async instance
   * @param {string} entryPath
   * @returns {Promise<string>}
   */
  async readZipText(zip, entryPath) {
    const data = await zip.entryData(entryPath)
    return data.toString('utf8').replace(/^﻿/, '')
  }

  /**
   * @param {string} xml
   * @returns {Promise<Object>}
   */
  parseXml(xml) {
    return xml2js.parseStringPromise(xml, { tagNameProcessors: [xml2js.processors.stripPrefix] })
  }

  /**
   * Ids of the given library items that still exist
   *
   * @param {string[]} libraryItemIds
   * @returns {Promise<Set<string>>}
   */
  async getExistingLibraryItemIds(libraryItemIds) {
    if (!libraryItemIds.length) return new Set()
    const libraryItems = await Database.libraryItemModel.findAll({
      attributes: ['id'],
      where: { id: libraryItemIds }
    })
    return new Set(libraryItems.map((li) => li.id))
  }

  /**
   * Delete cache files of library items that no longer exist, all but the newest file per item,
   * and stale temp dirs left by crashed conversions.
   *
   * @returns {Promise<number>} number of entries removed
   */
  async cleanup() {
    let removed = 0
    try {
      if (!(await fs.pathExists(this.cachePath))) return 0
      const entries = await fs.readdir(this.cachePath)

      /** @type {Map<string, {name: string, mtime: number}[]>} */
      const filesByItem = new Map()
      const toRemove = []
      for (const name of entries) {
        if (name.startsWith(TEMP_DIR_PREFIX)) {
          const stat = await fs.stat(Path.join(this.cachePath, name)).catch(() => null)
          if (stat && Date.now() - stat.mtimeMs > this.staleTempDirMs) toRemove.push(name)
          continue
        }
        const match = name.match(CACHE_FILE_REGEX)
        if (!match) continue
        const [, libraryItemId, mtime] = match
        if (!filesByItem.has(libraryItemId)) filesByItem.set(libraryItemId, [])
        filesByItem.get(libraryItemId).push({ name, mtime: Number(mtime) })
      }

      const existingIds = await this.getExistingLibraryItemIds([...filesByItem.keys()])
      for (const [libraryItemId, files] of filesByItem) {
        if (!existingIds.has(libraryItemId)) {
          toRemove.push(...files.map((f) => f.name))
          continue
        }
        files.sort((a, b) => b.mtime - a.mtime)
        toRemove.push(...files.slice(1).map((f) => f.name))
      }

      for (const name of toRemove) {
        try {
          await fs.remove(Path.join(this.cachePath, name))
          removed++
        } catch (error) {
          Logger.error(`[KepubManager] cleanup: Failed to remove "${name}"`, error)
        }
      }
      if (removed) Logger.info(`[KepubManager] cleanup: Removed ${removed} stale kepub cache entries`)
    } catch (error) {
      Logger.error('[KepubManager] cleanup: Failed', error)
    }
    return removed
  }
}
module.exports = new KepubManager()
