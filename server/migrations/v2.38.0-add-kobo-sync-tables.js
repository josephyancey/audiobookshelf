/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a suquelize QueryInterface object.
 * @property {import('../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.38.0'
const migrationName = `${migrationVersion}-add-kobo-sync-tables`
const loggerPrefix = `[${migrationVersion} migration]`

/**
 * Column definitions shared by every table
 * @param {import('sequelize').DataTypes} DataTypes
 */
function baseColumns(DataTypes) {
  return {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false
    }
  }
}

/**
 * @param {import('sequelize').DataTypes} DataTypes
 * @param {string} tableName
 */
function foreignKey(DataTypes, tableName) {
  return {
    type: DataTypes.UUID,
    references: {
      model: {
        tableName
      },
      key: 'id'
    },
    allowNull: false,
    onDelete: 'CASCADE'
  }
}

/**
 * @param {import('sequelize').QueryInterface} queryInterface
 * @param {import('../Logger')} logger
 * @param {string} tableName
 * @param {Object} columns
 * @param {{ fields: string[], unique?: boolean, name: string }[]} indexes
 */
async function createTableIfMissing(queryInterface, logger, tableName, columns, indexes) {
  if (await queryInterface.tableExists(tableName)) {
    logger.info(`${loggerPrefix} table "${tableName}" already exists`)
  } else {
    logger.info(`${loggerPrefix} creating table "${tableName}"`)
    await queryInterface.createTable(tableName, columns)
    logger.info(`${loggerPrefix} created table "${tableName}"`)
  }

  const existing = (await queryInterface.showIndex(tableName)).map((index) => index.name)
  for (const index of indexes) {
    if (existing.includes(index.name)) continue
    await queryInterface.addIndex(tableName, index)
    logger.info(`${loggerPrefix} added index "${index.name}"`)
  }
}

/**
 * This upward migration creates the tables used by Kobo sync.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)
  const DataTypes = queryInterface.sequelize.Sequelize.DataTypes

  await createTableIfMissing(
    queryInterface,
    logger,
    'koboDevices',
    {
      ...baseColumns(DataTypes),
      name: {
        type: DataTypes.STRING,
        allowNull: false
      },
      tokenHash: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
      },
      libraryIds: DataTypes.JSON,
      onlyCollections: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      collectionIds: DataTypes.JSON,
      lastSyncAt: DataTypes.DATE,
      lastIp: DataTypes.STRING,
      lastUserAgent: DataTypes.STRING,
      userId: foreignKey(DataTypes, 'users')
    },
    []
  )

  await createTableIfMissing(
    queryInterface,
    logger,
    'koboSyncedItems',
    {
      ...baseColumns(DataTypes),
      libraryItemId: {
        type: DataTypes.UUID,
        allowNull: false
      },
      deliveredAt: DataTypes.DATE,
      deliveredVersion: DataTypes.BIGINT,
      deliveredFormat: DataTypes.STRING,
      isRemoved: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      removedBy: DataTypes.STRING,
      pendingCheckpoint: DataTypes.STRING,
      pendingVersion: DataTypes.BIGINT,
      pendingFormat: DataTypes.STRING,
      pendingRemoved: DataTypes.BOOLEAN,
      koboDeviceId: foreignKey(DataTypes, 'koboDevices')
    },
    [
      { name: 'kobo_synced_items_kobo_device_id_library_item_id', fields: ['koboDeviceId', 'libraryItemId'], unique: true },
      { name: 'kobo_synced_items_kobo_device_id_pending_checkpoint', fields: ['koboDeviceId', 'pendingCheckpoint'] }
    ]
  )

  await createTableIfMissing(
    queryInterface,
    logger,
    'koboSyncedCollections',
    {
      ...baseColumns(DataTypes),
      collectionId: {
        type: DataTypes.UUID,
        allowNull: false
      },
      deliveredHash: DataTypes.STRING,
      isDeleted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      pendingCheckpoint: DataTypes.STRING,
      pendingHash: DataTypes.STRING,
      pendingDeleted: DataTypes.BOOLEAN,
      koboDeviceId: foreignKey(DataTypes, 'koboDevices')
    },
    [{ name: 'kobo_synced_collections_kobo_device_id_collection_id', fields: ['koboDeviceId', 'collectionId'], unique: true }]
  )

  await createTableIfMissing(
    queryInterface,
    logger,
    'koboReadingStates',
    {
      ...baseColumns(DataTypes),
      libraryItemId: {
        type: DataTypes.UUID,
        allowNull: false
      },
      currentBookmark: DataTypes.JSON,
      statusInfo: DataTypes.JSON,
      statistics: DataTypes.JSON,
      lastModified: DataTypes.STRING,
      priorityTimestamp: DataTypes.STRING,
      progressUpdatedAt: DataTypes.DATE,
      userId: foreignKey(DataTypes, 'users')
    },
    [{ name: 'kobo_reading_states_user_id_library_item_id', fields: ['userId', 'libraryItemId'], unique: true }]
  )

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * This downward migration removes the Kobo sync tables.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  for (const tableName of ['koboSyncedItems', 'koboSyncedCollections', 'koboReadingStates', 'koboDevices']) {
    if (await queryInterface.tableExists(tableName)) {
      await queryInterface.dropTable(tableName)
      logger.info(`${loggerPrefix} dropped table "${tableName}"`)
    }
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }
