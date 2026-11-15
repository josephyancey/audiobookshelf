const { expect } = require('chai')
const sinon = require('sinon')
const { Sequelize, DataTypes } = require('sequelize')

const { up, down } = require('../../../server/migrations/v2.38.0-add-kobo-sync-tables')

describe('Migration v2.38.0-add-kobo-sync-tables', () => {
  let sequelize, queryInterface, logger

  beforeEach(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    queryInterface = sequelize.getQueryInterface()
    await queryInterface.createTable('users', { id: { type: DataTypes.UUID, primaryKey: true } })
    logger = { info: sinon.stub(), error: sinon.stub() }
  })

  afterEach(async () => {
    await sequelize.close()
  })

  it('creates the Kobo tables and their unique indexes', async () => {
    await up({ context: { queryInterface, logger } })
    for (const table of ['koboDevices', 'koboSyncedItems', 'koboSyncedCollections', 'koboReadingStates']) {
      expect(await queryInterface.tableExists(table), table).to.equal(true)
    }
    const indexes = (await queryInterface.showIndex('koboSyncedItems')).map((index) => index.name)
    expect(indexes).to.include('kobo_synced_items_kobo_device_id_library_item_id')
    const columns = await queryInterface.describeTable('koboReadingStates')
    expect(columns).to.include.keys('currentBookmark', 'lastModified', 'priorityTimestamp', 'progressUpdatedAt', 'userId')
  })

  it('can run twice', async () => {
    await up({ context: { queryInterface, logger } })
    await up({ context: { queryInterface, logger } })
    expect(logger.info.calledWith(sinon.match('table "koboDevices" already exists'))).to.equal(true)
  })

  it('drops the tables on the way down', async () => {
    await up({ context: { queryInterface, logger } })
    await down({ context: { queryInterface, logger } })
    for (const table of ['koboDevices', 'koboSyncedItems', 'koboSyncedCollections', 'koboReadingStates']) {
      expect(await queryInterface.tableExists(table), table).to.equal(false)
    }
  })
})
