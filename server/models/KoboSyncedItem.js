const { DataTypes, Model } = require('sequelize')

/**
 * What one Kobo device has been sent, per library item.
 *
 * Calibre-Web marks a book as sent while it builds the response, so a sync the device aborts
 * loses those books for good (Calibre-Web-Automated #1470). Here an emitted row only records
 * a pending state under the checkpoint of the page it went out in. The device echoes the
 * checkpoint back in its next sync token, and only then does the pending state become the
 * delivered state. A page the device never confirmed is simply sent again.
 */
class KoboSyncedItem extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.koboDeviceId
    /** @type {UUIDV4} Not a foreign key: a deleted item must still be removed from the device */
    this.libraryItemId
    /** @type {Date} When the device first confirmed this item, null if never */
    this.deliveredAt
    /** @type {number} Item version (epoch ms) the device last confirmed */
    this.deliveredVersion
    /** @type {string} 'kepub' or 'epub' */
    this.deliveredFormat
    /** @type {boolean} The device last confirmed a removal */
    this.isRemoved
    /** @type {string} 'device' when the user deleted it on the Kobo, 'scope' when it left the sync scope */
    this.removedBy
    /** @type {string} Checkpoint of the page carrying an unconfirmed change */
    this.pendingCheckpoint
    /** @type {number} */
    this.pendingVersion
    /** @type {string} */
    this.pendingFormat
    /** @type {boolean} */
    this.pendingRemoved
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * Make every change sent under a checkpoint the delivered state
   * @param {string} koboDeviceId
   * @param {string} checkpoint
   * @returns {Promise<number>} rows confirmed
   */
  static async confirmCheckpoint(koboDeviceId, checkpoint) {
    if (!checkpoint) return 0
    const rows = await this.findAll({ where: { koboDeviceId, pendingCheckpoint: checkpoint } })
    for (const row of rows) {
      const removed = !!row.pendingRemoved
      await row.update({
        deliveredAt: row.deliveredAt || new Date(),
        deliveredVersion: row.pendingVersion,
        deliveredFormat: row.pendingFormat,
        isRemoved: removed,
        removedBy: removed ? row.removedBy || 'scope' : null,
        pendingCheckpoint: null,
        pendingVersion: null,
        pendingFormat: null,
        pendingRemoved: null
      })
    }
    return rows.length
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
        pendingRemoved: DataTypes.BOOLEAN
      },
      {
        sequelize,
        modelName: 'koboSyncedItem',
        indexes: [
          {
            unique: true,
            fields: ['koboDeviceId', 'libraryItemId']
          },
          {
            fields: ['koboDeviceId', 'pendingCheckpoint']
          }
        ]
      }
    )

    const { koboDevice } = sequelize.models
    koboDevice.hasMany(KoboSyncedItem, {
      onDelete: 'CASCADE'
    })
    KoboSyncedItem.belongsTo(koboDevice)
  }
}

module.exports = KoboSyncedItem
