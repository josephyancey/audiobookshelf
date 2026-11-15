const { DataTypes, Model } = require('sequelize')

/**
 * What one Kobo device has been sent, per collection. Same checkpoint scheme as
 * {@link import('./KoboSyncedItem')}: a tag change only counts as delivered once the device
 * echoes the checkpoint back. `deliveredHash` covers the name and the full book list, because
 * a Kobo collection is always sent whole and adding a book to an ABS collection does not
 * touch the collection's own updatedAt.
 */
class KoboSyncedCollection extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.koboDeviceId
    /** @type {UUIDV4} Not a foreign key: a deleted collection must still be deleted on the device */
    this.collectionId
    /** @type {string} */
    this.deliveredHash
    /** @type {boolean} */
    this.isDeleted
    /** @type {string} */
    this.pendingCheckpoint
    /** @type {string} */
    this.pendingHash
    /** @type {boolean} */
    this.pendingDeleted
  }

  /**
   * @param {string} koboDeviceId
   * @param {string} checkpoint
   * @returns {Promise<number>}
   */
  static async confirmCheckpoint(koboDeviceId, checkpoint) {
    const [count] = await this.update(
      {
        deliveredHash: this.sequelize.col('pendingHash'),
        isDeleted: this.sequelize.col('pendingDeleted'),
        pendingCheckpoint: null,
        pendingHash: null,
        pendingDeleted: null
      },
      { where: { koboDeviceId, pendingCheckpoint: checkpoint } }
    )
    return count
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
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
        pendingDeleted: DataTypes.BOOLEAN
      },
      {
        sequelize,
        modelName: 'koboSyncedCollection',
        indexes: [
          {
            unique: true,
            fields: ['koboDeviceId', 'collectionId']
          }
        ]
      }
    )

    const { koboDevice } = sequelize.models
    koboDevice.hasMany(KoboSyncedCollection, {
      onDelete: 'CASCADE'
    })
    KoboSyncedCollection.belongsTo(koboDevice)
  }
}

module.exports = KoboSyncedCollection
