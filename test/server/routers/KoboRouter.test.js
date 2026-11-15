const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const express = require('express')
const axios = require('axios')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const archiver = require('../../../server/libs/archiver')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const ServerSettings = require('../../../server/objects/settings/ServerSettings')
const KoboRouter = require('../../../server/routers/KoboRouter')
const KoboController = require('../../../server/controllers/KoboController')
const KepubManager = require('../../../server/managers/KepubManager')
const KoboStoreProxy = require('../../../server/managers/KoboStoreProxy')
const { parseSyncToken } = require('../../../server/utils/kobo/syncToken')

const CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
const OPF =
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>' +
  '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
  '</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>'
const CHAPTER_ONE = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><p><span class="koboSpan" id="kobo.1.1">It was a long night.</span></p></body></html>'
const CHAPTER_TWO =
  '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><div id="book-columns"><div id="book-inner">' +
  '<p><span class="koboSpan" id="kobo.1.1">Morning came. </span><span class="koboSpan" id="kobo.1.2">Nobody spoke.</span></p>' +
  '<p><span class="koboSpan" id="kobo.2.1">Then the engines started.</span></p></div></div></body></html>'

const tempDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'kobo-router-'))

function writeKepub(name) {
  const file = Path.join(tempDir, name)
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file)
    const archive = archiver('zip', { zlib: { level: 6 } })
    output.on('close', () => resolve(file))
    archive.on('error', reject)
    archive.pipe(output)
    archive.append('application/epub+zip', { name: 'mimetype', store: true })
    archive.append(CONTAINER, { name: 'META-INF/container.xml' })
    archive.append(OPF, { name: 'OEBPS/content.opf' })
    archive.append(CHAPTER_ONE, { name: 'OEBPS/ch1.xhtml' })
    archive.append(CHAPTER_TWO, { name: 'OEBPS/ch2.xhtml' })
    archive.finalize()
  })
}

describe('KoboRouter', () => {
  let server
  let baseUrl
  let library
  let libraryFolder
  let user
  let token
  let device
  let ebookPath

  /** A fake Kobo: remembers the last sync token like the device does */
  class Kobo {
    constructor(deviceToken) {
      this.token = deviceToken
      this.syncToken = ''
    }

    url(path) {
      return `${baseUrl}/kobo/${this.token}${path}`
    }

    request(method, path, data, headers = {}) {
      return axios.request({ method, url: this.url(path), data, headers, validateStatus: () => true, maxRedirects: 0 })
    }

    async sync({ remember = true } = {}) {
      const res = await this.request('get', '/v1/library/sync', undefined, this.syncToken ? { 'x-kobo-synctoken': this.syncToken } : {})
      expect(res.status).to.equal(200)
      expect(res.headers['content-type']).to.include('charset=utf-8')
      expect(res.headers['x-kobo-synctoken']).to.be.a('string').and.not.match(/^b'/)
      if (remember) this.syncToken = res.headers['x-kobo-synctoken']
      return { body: res.data, more: res.headers['x-kobo-sync'] === 'continue' }
    }

    /** Sync pages until the server says there is no more */
    async syncAll() {
      const all = []
      for (let page = 0; page < 20; page++) {
        const { body, more } = await this.sync()
        all.push(...body)
        if (!more) return all
      }
      throw new Error('sync never finished')
    }
  }

  const entitlementIds = (results, kind) => results.filter((r) => r[kind]).map((r) => r[kind].BookEntitlement.Id)

  async function addBook(title, extra = {}) {
    const book = await Database.bookModel.create({
      title,
      audioFiles: [],
      tags: extra.tags || [],
      narrators: [],
      genres: [],
      chapters: [],
      language: 'English',
      ebookFile: {
        ino: `${title}-ino`,
        ebookFormat: extra.ebookFormat || 'epub',
        metadata: { filename: Path.basename(ebookPath), ext: '.epub', path: extra.path || ebookPath, size: 1234, mtimeMs: 1 }
      }
    })
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: extra.libraryId || library.id, libraryFolderId: libraryFolder.id, title })
    return libraryItem
  }

  before(async () => {
    ebookPath = await writeKepub('book.epub')
    global.MetadataPath = tempDir
  })

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    Database.serverSettings = new ServerSettings({ koboSyncEnabled: true, koboStoreProxy: false })
    global.ServerSettings = Database.serverSettings.toJSON()

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(SocketAuthority, 'clientEmitter')
    sinon.stub(KepubManager, 'isAvailable').returns(false)

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    libraryFolder = await Database.libraryFolderModel.create({ path: tempDir, libraryId: library.id })
    user = await Database.userModel.create({
      username: `reader-${Date.now()}-${Math.random()}`,
      pash: 'hash',
      token: 'token',
      type: 'admin',
      isActive: true,
      permissions: Database.userModel.getDefaultPermissionsForUserType('admin'),
      bookmarks: [],
      extraData: {}
    })
    token = Database.koboDeviceModel.generateToken()
    device = await Database.koboDeviceModel.create({ name: 'Libra', tokenHash: Database.koboDeviceModel.hashToken(token), userId: user.id })

    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.originalHostPrefix = baseUrl
      next()
    })
    app.use(KoboController.readingServicesStub.bind(KoboController))
    app.use('/kobo/:token', new KoboRouter().router)
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    sinon.restore()
    await new Promise((resolve) => server.close(resolve))
    await Database.sequelize.sync({ force: true })
  })

  describe('auth', () => {
    it('refuses an unknown token with 401', async () => {
      const res = await new Kobo('0'.repeat(32)).request('get', '/v1/library/sync')
      expect(res.status).to.equal(401)
    })

    it('refuses everything while Kobo sync is disabled', async () => {
      Database.serverSettings.koboSyncEnabled = false
      const res = await new Kobo(token).request('get', '/v1/library/sync')
      expect(res.status).to.equal(403)
    })

    it('refuses sync for a user without download permission', async () => {
      await user.update({ permissions: { ...user.permissions, download: false } })
      const res = await new Kobo(token).request('get', '/v1/library/sync')
      expect(res.status).to.equal(403)
    })
  })

  describe('initialization', () => {
    it('points library sync and images at this server and answers OAuth when not forwarding', async () => {
      const res = await new Kobo(token).request('get', '/v1/initialization')
      expect(res.status).to.equal(200)
      expect(res.headers['x-kobo-apitoken']).to.equal('e30=')
      const resources = res.data.Resources
      expect(resources.library_sync).to.equal(`${baseUrl}/kobo/${token}/v1/library/sync`)
      expect(resources.image_url_template).to.equal(`${baseUrl}/kobo/${token}/{ImageId}/{Width}/{Height}/false/image.jpg`)
      expect(resources.oauth_host).to.equal(`${baseUrl}/kobo/${token}/oauth`)
      expect(resources.reading_services_host).to.equal(baseUrl)
    })

    it('uses the public URL setting over the request host', async () => {
      Database.serverSettings.koboPublicUrl = 'https://books.example.com'
      const res = await new Kobo(token).request('get', '/v1/initialization')
      expect(res.data.Resources.library_sync).to.equal(`https://books.example.com/kobo/${token}/v1/library/sync`)
    })

    it('serves OIDC discovery with a token endpoint', async () => {
      const res = await new Kobo(token).request('get', '/oauth/.well-known/openid-configuration')
      expect(res.data.token_endpoint).to.equal(`${baseUrl}/kobo/${token}/oauth/token`)
      const tokenRes = await new Kobo(token).request('post', '/oauth/token', {})
      expect(tokenRes.data.access_token).to.be.a('string')
    })

    it('answers device auth with dummy tokens when not forwarding', async () => {
      const res = await new Kobo(token).request('post', '/v1/auth/device', { UserKey: 'abc' })
      expect(res.data.UserKey).to.equal('abc')
      expect(res.data.TokenType).to.equal('Bearer')
      const noBody = await new Kobo(token).request('post', '/v1/user/add-device')
      expect(noBody.status).to.equal(200)
    })
  })

  describe('library sync', () => {
    it('sends new books with metadata, then nothing once the device confirmed them', async () => {
      const item = await addBook('First Book')
      const kobo = new Kobo(token)
      const first = await kobo.sync()
      expect(entitlementIds(first.body, 'NewEntitlement')).to.deep.equal([item.id])
      const metadata = first.body[0].NewEntitlement.BookMetadata
      expect(metadata.Title).to.equal('First Book')
      expect(metadata.Language).to.equal('en')
      expect(metadata.DownloadUrls.map((url) => url.Format)).to.deep.equal(['EPUB3', 'EPUB'])
      expect(metadata.DownloadUrls[0].Url).to.equal(`${baseUrl}/kobo/${token}/download/${item.id}/epub`)
      expect(metadata.CoverImageId).to.match(new RegExp(`^${item.id}-\\d+$`))
      expect(first.more).to.equal(false)

      const second = await kobo.sync()
      expect(second.body).to.deep.equal([])
    })

    it('sends a page again when the device never confirmed it', async () => {
      const item = await addBook('Lost Page')
      const kobo = new Kobo(token)
      await kobo.sync({ remember: false })
      const retry = await kobo.sync()
      expect(entitlementIds(retry.body, 'NewEntitlement')).to.deep.equal([item.id])
      expect((await kobo.sync()).body).to.deep.equal([])
    })

    it('pages a large library 100 at a time with continue', async () => {
      for (let i = 0; i < 130; i++) await addBook(`Book ${i}`)
      const kobo = new Kobo(token)
      const page1 = await kobo.sync()
      expect(page1.body.length).to.equal(100)
      expect(page1.more).to.equal(true)
      const page2 = await kobo.sync()
      expect(page2.body.length).to.equal(30)
      expect(page2.more).to.equal(false)
      const ids = new Set([...entitlementIds(page1.body, 'NewEntitlement'), ...entitlementIds(page2.body, 'NewEntitlement')])
      expect(ids.size).to.equal(130)
      expect((await kobo.sync()).body).to.deep.equal([])
    })

    it('sends a changed book as ChangedEntitlement', async () => {
      const item = await addBook('Old Title')
      const kobo = new Kobo(token)
      await kobo.syncAll()
      await kobo.sync()
      const book = await Database.bookModel.findByPk(item.mediaId)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await book.update({ title: 'New Title' })
      const res = await kobo.sync()
      expect(entitlementIds(res.body, 'ChangedEntitlement')).to.deep.equal([item.id])
      expect(res.body[0].ChangedEntitlement.BookMetadata.Title).to.equal('New Title')
    })

    it('removes books that leave the device scope', async () => {
      const item = await addBook('Leaving')
      const otherLibrary = await Database.libraryModel.create({ name: 'Other', mediaType: 'book' })
      const kobo = new Kobo(token)
      await kobo.syncAll()
      await device.update({ libraryIds: [otherLibrary.id] })
      const res = await kobo.sync()
      expect(res.body[0].ChangedEntitlement.BookEntitlement.Id).to.equal(item.id)
      expect(res.body[0].ChangedEntitlement.BookEntitlement.IsRemoved).to.equal(true)
      await kobo.sync()
      expect((await kobo.sync()).body).to.deep.equal([])
    })

    it('removes a deleted library item from the device', async () => {
      const item = await addBook('Deleted')
      const kobo = new Kobo(token)
      await kobo.syncAll()
      await Database.libraryItemModel.destroy({ where: { id: item.id } })
      const res = await kobo.sync()
      expect(res.body[0].ChangedEntitlement.BookEntitlement).to.include({ Id: item.id, IsRemoved: true })
    })

    it('keeps a book deleted on the Kobo off that device until a resync', async () => {
      const item = await addBook('Deleted On Device')
      const kobo = new Kobo(token)
      await kobo.syncAll()
      await kobo.sync()
      const del = await kobo.request('delete', `/v1/library/${item.id}`)
      expect(del.status).to.equal(204)
      expect((await kobo.sync()).body).to.deep.equal([])

      await Database.koboSyncedItemModel.destroy({ where: { koboDeviceId: device.id } })
      const resynced = await kobo.sync()
      expect(entitlementIds(resynced.body, 'NewEntitlement')).to.deep.equal([item.id])
    })

    it('gives a second Kobo of the same user every book (state is per device)', async () => {
      const item = await addBook('Shared')
      await new Kobo(token).syncAll()
      const secondToken = Database.koboDeviceModel.generateToken()
      await Database.koboDeviceModel.create({ name: 'Clara', tokenHash: Database.koboDeviceModel.hashToken(secondToken), userId: user.id })
      const res = await new Kobo(secondToken).sync()
      expect(entitlementIds(res.body, 'NewEntitlement')).to.deep.equal([item.id])
    })

    it('skips books the user cannot access', async () => {
      await user.update({ permissions: { ...user.permissions, accessAllTags: false, itemTagsSelected: ['ok'] } })
      const allowed = await addBook('Allowed', { tags: ['ok'] })
      await addBook('Hidden', { tags: ['nope'] })
      const res = await new Kobo(token).sync()
      expect(entitlementIds(res.body, 'NewEntitlement')).to.deep.equal([allowed.id])
    })

    it('offers a single KEPUB when kepubify is available', async () => {
      KepubManager.isAvailable.returns(true)
      const item = await addBook('Kepub Me')
      const res = await new Kobo(token).sync()
      const urls = res.body[0].NewEntitlement.BookMetadata.DownloadUrls
      expect(urls).to.have.length(1)
      expect(urls[0]).to.include({ Format: 'KEPUB', Url: `${baseUrl}/kobo/${token}/download/${item.id}/kepub` })
    })

    it('starts fresh on an unreadable sync token and on a store token', async () => {
      await addBook('Fresh')
      const kobo = new Kobo(token)
      kobo.syncToken = 'not-base64-json'
      expect((await kobo.sync()).body).to.have.length(1)
      expect(parseSyncToken('header.payload.sig').rawKoboStoreToken).to.equal('header.payload.sig')
    })
  })

  describe('reading state', () => {
    let item
    beforeEach(async () => {
      item = await addBook('Reading', { ebookFormat: 'kepub' })
    })

    async function getProgress() {
      return Database.mediaProgressModel.findOne({ where: { userId: user.id, mediaItemId: item.mediaId } })
    }

    it('turns a KoboSpan bookmark into an exact ABS position and hands it back verbatim', async () => {
      const kobo = new Kobo(token)
      const put = await kobo.request('put', `/v1/library/${item.id}/state`, {
        ReadingStates: [
          {
            LastModified: '2026-11-14T10:00:00Z',
            PriorityTimestamp: '2026-11-14T10:00:00Z',
            CurrentBookmark: { LastModified: '2026-11-14T10:00:00Z', ProgressPercent: 50, ContentSourceProgressPercent: 50, Location: { Source: 'OEBPS/ch2.xhtml', Type: 'KoboSpan', Value: 'kobo.2.1' } },
            StatusInfo: { LastModified: '2026-11-14T10:00:00Z', Status: 'Reading', TimesStartedReading: 1 }
          }
        ]
      })
      expect(put.status).to.equal(200)
      expect(put.data.RequestResult).to.equal('Success')
      expect(put.data.UpdateResults[0]).to.not.have.property('LastModified')

      const progress = await getProgress()
      const before = 'It was a long night.'.length + 'Morning came. Nobody spoke.'.length
      const total = before + 'Then the engines started.'.length
      expect(progress.ebookProgress).to.equal(before / total)
      expect(progress.ebookLocation).to.match(/^epubcfi\(\/6\/4\[ch2\]!/)

      const get = await kobo.request('get', `/v1/library/${item.id}/state`)
      expect(get.data[0].LastModified).to.equal('2026-11-14T10:00:00Z')
      expect(get.data[0].PriorityTimestamp).to.equal('2026-11-14T10:00:00Z')
      expect(get.data[0].CurrentBookmark.ProgressPercent).to.equal(50)
      expect(get.data[0].CurrentBookmark.Location.Value).to.equal('kobo.2.1')
    })

    it('accepts a state with no bookmark at all', async () => {
      const res = await new Kobo(token).request('put', `/v1/library/${item.id}/state`, { ReadingStates: [{ StatusInfo: { Status: 'Reading' } }] })
      expect(res.status).to.equal(200)
      const empty = await new Kobo(token).request('put', `/v1/library/${item.id}/state`, {})
      expect(empty.status).to.equal(200)
    })

    it('sends a position moved in ABS to the device as a KoboSpan', async () => {
      const kobo = new Kobo(token)
      await kobo.syncAll()
      await kobo.sync()
      const freshUser = await Database.userModel.getUserById(user.id)
      // Exactly the start of "Nobody spoke." in chapter two
      const offset = 'It was a long night.'.length + 'Morning came. '.length
      const total = 'It was a long night.'.length + 'Morning came. Nobody spoke.Then the engines started.'.length
      await freshUser.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, ebookProgress: offset / total })
      const res = await kobo.sync()
      const changed = res.body.find((entry) => entry.ChangedReadingState)
      expect(changed, JSON.stringify(res.body)).to.exist
      const bookmark = changed.ChangedReadingState.ReadingState.CurrentBookmark
      expect(bookmark.Location).to.deep.equal({ Source: 'OEBPS/ch2.xhtml', Type: 'KoboSpan', Value: 'kobo.1.2' })
      expect(Number.isInteger(bookmark.ProgressPercent)).to.equal(true)
    })

    it('marks the book finished, and only the device reopening it unfinishes it', async () => {
      const kobo = new Kobo(token)
      await kobo.request('put', `/v1/library/${item.id}/state`, { ReadingStates: [{ StatusInfo: { Status: 'Finished' } }] })
      expect((await getProgress()).isFinished).to.equal(true)
      await kobo.request('put', `/v1/library/${item.id}/state`, { ReadingStates: [{ StatusInfo: { Status: 'Reading' } }] })
      expect((await getProgress()).isFinished).to.equal(false)
    })

    it('does not unfinish a book finished elsewhere when the device says Reading', async () => {
      const freshUser = await Database.userModel.getUserById(user.id)
      await freshUser.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, isFinished: true })
      await new Kobo(token).request('put', `/v1/library/${item.id}/state`, { ReadingStates: [{ StatusInfo: { Status: 'Reading' } }] })
      expect((await getProgress()).isFinished).to.equal(true)
    })
  })

  describe('collections', () => {
    it('sends collections as tags with every book, then changes and deletions', async () => {
      const item = await addBook('Collected')
      const collection = await Database.collectionModel.create({ libraryId: library.id, name: 'Favorites' })
      await Database.collectionBookModel.create({ collectionId: collection.id, bookId: item.mediaId, order: 1 })
      const kobo = new Kobo(token)
      const first = await kobo.sync()
      const tag = first.body.find((entry) => entry.NewTag).NewTag.Tag
      expect(tag).to.include({ Id: collection.id, Name: 'Favorites', Type: 'UserTag' })
      expect(tag.Items).to.deep.equal([{ RevisionId: item.id, Type: 'ProductRevisionTagItem' }])

      await kobo.sync()
      await collection.update({ name: 'Best' })
      const renamed = await kobo.sync()
      expect(renamed.body.find((entry) => entry.ChangedTag).ChangedTag.Tag.Name).to.equal('Best')

      await kobo.sync()
      await collection.destroy()
      const deleted = await kobo.sync()
      expect(deleted.body.find((entry) => entry.DeletedTag).DeletedTag.Tag.Id).to.equal(collection.id)
    })

    it('only syncs selected collections when asked', async () => {
      const inCollection = await addBook('In')
      await addBook('Out')
      const collection = await Database.collectionModel.create({ libraryId: library.id, name: 'Kobo' })
      await Database.collectionBookModel.create({ collectionId: collection.id, bookId: inCollection.mediaId, order: 1 })
      await device.update({ onlyCollections: true, collectionIds: [collection.id] })
      const res = await new Kobo(token).sync()
      expect(entitlementIds(res.body, 'NewEntitlement')).to.deep.equal([inCollection.id])
    })

    it('applies collection edits from the Kobo when the user may update', async () => {
      const item = await addBook('Tagged')
      const kobo = new Kobo(token)
      const created = await kobo.request('post', '/v1/library/tags', { Name: 'From Kobo', Items: [{ RevisionId: item.id, Type: 'ProductRevisionTagItem' }] })
      expect(created.status).to.equal(201)
      const collection = await Database.collectionModel.findByPk(created.data)
      expect(collection.name).to.equal('From Kobo')
      expect(await Database.collectionBookModel.count({ where: { collectionId: collection.id } })).to.equal(1)

      await kobo.request('put', `/v1/library/tags/${collection.id}`, { Name: 'Renamed' })
      expect((await collection.reload()).name).to.equal('Renamed')
      await kobo.request('post', `/v1/library/tags/${collection.id}/items/delete`, { Items: [{ RevisionId: item.id }] })
      expect(await Database.collectionBookModel.count({ where: { collectionId: collection.id } })).to.equal(0)
    })

    it('accepts but ignores collection edits from a user without permission', async () => {
      await user.update({ type: 'user', permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
      const res = await new Kobo(token).request('post', '/v1/library/tags', { Name: 'Nope', Items: [] })
      expect(res.status).to.equal(201)
      expect(await Database.collectionModel.count()).to.equal(0)
    })
  })

  describe('Kobo store forwarding', () => {
    beforeEach(() => {
      Database.serverSettings.koboStoreProxy = true
      sinon.stub(KoboStoreProxy, 'getStoreResources').resolves({ resources: { library_sync: 'https://storeapi.kobo.com/v1/library/sync', oauth_host: 'https://oauth.kobo.com', some_store_page: 'https://kobo.com/x' }, expiredToken: null })
    })

    it('redirects store GETs with 307 so the device keeps its own store headers', async () => {
      const res = await new Kobo(token).request('get', '/v1/user/profile?x=1')
      expect(res.status).to.equal(307)
      expect(res.headers.location).to.equal('https://storeapi.kobo.com/v1/user/profile?x=1')
    })

    it('redirects an unknown cover to the Kobo CDN', async () => {
      const res = await new Kobo(token).request('get', '/abc-store-book/355/530/false/image.jpg')
      expect(res.status).to.equal(307)
      expect(res.headers.location).to.equal('https://cdn.kobo.com/book-images/abc-store-book/355/530/false/image.jpg')
    })

    it('keeps the store resources but always points library sync here', async () => {
      const res = await new Kobo(token).request('get', '/v1/initialization')
      expect(res.data.Resources.some_store_page).to.equal('https://kobo.com/x')
      expect(res.data.Resources.oauth_host).to.equal('https://oauth.kobo.com')
      expect(res.data.Resources.library_sync).to.equal(`${baseUrl}/kobo/${token}/v1/library/sync`)
    })

    it('falls back to dummy auth when the store cannot be reached', async () => {
      sinon.stub(KoboStoreProxy, 'request').rejects(new Error('offline'))
      const res = await new Kobo(token).request('post', '/v1/auth/device', { UserKey: 'k' })
      expect(res.status).to.equal(200)
      expect(res.data.UserKey).to.equal('k')
    })

    it('merges the store library into the last page only, keeping its token inside ours', async () => {
      for (let i = 0; i < 101; i++) await addBook(`Book ${i}`)
      const storeSync = sinon.stub(KoboStoreProxy, 'getStoreSync').resolves({ results: [{ NewEntitlement: { BookEntitlement: { Id: 'store-book' } } }], rawKoboStoreToken: 'store.token.2', headers: { 'x-kobo-sync-mode': 'Incremental' } })
      const kobo = new Kobo(token)
      kobo.syncToken = 'store.token.1'
      const page1 = await kobo.sync()
      expect(page1.more).to.equal(true)
      expect(storeSync.called).to.equal(false)
      const page2 = await kobo.sync()
      expect(storeSync.calledOnce).to.equal(true)
      expect(storeSync.firstCall.args[1]).to.equal('store.token.1')
      expect(page2.body.map((entry) => entry.NewEntitlement?.BookEntitlement.Id)).to.include('store-book')
      expect(parseSyncToken(kobo.syncToken).rawKoboStoreToken).to.equal('store.token.2')
    })
  })

  describe('files and everything else', () => {
    it('downloads the ebook, falling back to epub when no kepub exists', async () => {
      const item = await addBook('Download Me')
      const res = await new Kobo(token).request('get', `/download/${item.id}/kepub`)
      expect(res.status).to.equal(200)
      expect(res.headers['content-disposition']).to.include('Download Me.epub')
    })

    it('names a kepub download .kepub.epub', async () => {
      const item = await addBook('Already Kepub', { ebookFormat: 'kepub' })
      const res = await new Kobo(token).request('get', `/download/${item.id}/kepub`)
      expect(res.headers['content-disposition']).to.include('Already Kepub.kepub.epub')
    })

    it('answers unknown endpoints and store books with {} instead of 404', async () => {
      const kobo = new Kobo(token)
      for (const path of ['/v1/user/profile', '/v1/products/featured/abc', '/v1/library/00000000-0000-4000-8000-000000000000/metadata']) {
        const res = await kobo.request('get', path)
        expect(res.status, path).to.equal(200)
        expect(res.data, path).to.deep.equal({})
      }
    })

    it('404s an unknown cover when not forwarding to the store', async () => {
      const res = await new Kobo(token).request('get', '/00000000-0000-4000-8000-000000000000-1/300/400/false/image.jpg')
      expect(res.status).to.equal(404)
    })

    it('stubs Kobo reading services at the site root only when not forwarding', async () => {
      const res = await axios.get(`${baseUrl}/api/v3/content/checkforchanges`, { validateStatus: () => true })
      expect(res.data).to.deep.equal([])
      Database.serverSettings.koboStoreProxy = true
      const passed = await axios.get(`${baseUrl}/api/v3/content/checkforchanges`, { validateStatus: () => true })
      expect(passed.status).to.equal(404)
    })
  })
})
