const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../../../server/Logger')
const { koboTimestamp, toIsoLanguage, buildBookMetadata } = require('../../../../server/utils/kobo/koboJson')
const { parseSyncToken, buildSyncToken } = require('../../../../server/utils/kobo/syncToken')

describe('koboJson', () => {
  it('formats timestamps without fractions and falls back on bad dates', () => {
    expect(koboTimestamp(new Date('2026-11-14T10:20:30.456Z'))).to.equal('2026-11-14T10:20:30Z')
    expect(koboTimestamp('not a date', Date.UTC(2020, 0, 1))).to.equal('2020-01-01T00:00:00Z')
    expect(koboTimestamp(null, Date.UTC(2020, 0, 1))).to.equal('2020-01-01T00:00:00Z')
  })

  it('maps free text languages to two letter codes', () => {
    expect(toIsoLanguage('English')).to.equal('en')
    expect(toIsoLanguage('german')).to.equal('de')
    expect(toIsoLanguage('fra')).to.equal('fr')
    expect(toIsoLanguage('pt_BR')).to.equal('pt')
    expect(toIsoLanguage('Klingon-ish')).to.equal('en')
    expect(toIsoLanguage(null)).to.equal('en')
  })

  it('builds metadata with every author and a numeric series index', () => {
    const libraryItem = {
      id: '11111111-2222-4333-8444-555555555555',
      createdAt: new Date(),
      media: {
        title: 'Leviathan Wakes',
        publisher: 'Orbit',
        publishedYear: '2011',
        language: 'English',
        authors: [{ name: 'James S. A. Corey' }, { name: 'Second Author' }],
        series: [{ name: 'The Expanse', bookSeries: { sequence: '1.5' } }]
      }
    }
    const metadata = buildBookMetadata(libraryItem, { downloadUrls: [], coverImageId: 'cover' })
    expect(metadata.Contributors).to.deep.equal(['James S. A. Corey', 'Second Author'])
    expect(metadata.ContributorRoles).to.deep.equal([{ Name: 'James S. A. Corey' }, { Name: 'Second Author' }])
    expect(metadata.Series).to.deep.include({ Name: 'The Expanse', Number: 1.5, NumberFloat: 1.5 })
    // Calibre-Web's series id, python: str(uuid.uuid3(uuid.NAMESPACE_DNS, 'python.org'))
    libraryItem.media.series[0].name = 'python.org'
    expect(buildBookMetadata(libraryItem, { downloadUrls: [], coverImageId: 'cover' }).Series.Id).to.equal('6fa459ea-ee8a-3ca4-894e-db77e160355e')
    expect(metadata.PublicationDate).to.equal('2011-01-01T00:00:00Z')
    expect(metadata.Publisher).to.deep.equal({ Imprint: '', Name: 'Orbit' })
  })
})

describe('syncToken', () => {
  beforeEach(() => sinon.stub(Logger, 'warn'))
  afterEach(() => sinon.restore())

  it('round trips as a plain base64 string', () => {
    const header = buildSyncToken({ rawKoboStoreToken: 'store', checkpoint: 'abc', readingStateLastModified: 42 })
    expect(header).to.be.a('string').and.not.match(/^b'/)
    expect(parseSyncToken(header)).to.deep.equal({ rawKoboStoreToken: 'store', checkpoint: 'abc', readingStateLastModified: 42 })
  })

  it('tolerates missing base64 padding', () => {
    const header = buildSyncToken({ checkpoint: 'x', readingStateLastModified: 1 }).replace(/=+$/, '')
    expect(parseSyncToken(header).checkpoint).to.equal('x')
  })

  it('keeps a Kobo store token and starts fresh', () => {
    expect(parseSyncToken('aaa.bbb')).to.deep.equal({ rawKoboStoreToken: 'aaa.bbb', checkpoint: null, readingStateLastModified: 0 })
  })

  it('starts fresh on garbage', () => {
    expect(parseSyncToken('%%%')).to.deep.equal({ rawKoboStoreToken: '', checkpoint: null, readingStateLastModified: 0 })
    expect(parseSyncToken(undefined).checkpoint).to.equal(null)
  })
})
