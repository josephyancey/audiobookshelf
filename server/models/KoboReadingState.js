const { DataTypes, Model } = require('sequelize')

/**
 * The last reading state a Kobo reported for a book, kept verbatim.
 *
 * Audiobookshelf media progress stays the source of truth. This row only remembers the Kobo's
 * own representation so it can be handed back exactly as the device sent it: numbers with the
 * same type, and the device's own LastModified/PriorityTimestamp. A server-stamped timestamp
 * or a 50 that comes back as 50.0 is what makes a Kobo ask "Return to last page read?"
 * (Calibre-Web d229f711, open PR #3607).
 *
 * Progress belongs to the user, not the device, as in Calibre-Web.
 */
class KoboReadingState extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.userId
    /** @type {UUIDV4} */
    this.libraryItemId
    /** @type {Object} Raw CurrentBookmark */
    this.currentBookmark
    /** @type {Object} Raw StatusInfo */
    this.statusInfo
    /** @type {Object} Raw Statistics */
    this.statistics
    /** @type {string} The device's LastModified, verbatim */
    this.lastModified
    /** @type {string} The device's PriorityTimestamp, verbatim */
    this.priorityTimestamp
    /** @type {string} Ebook location, progress and finished state of the media progress this state stands for */
    this.snapshot
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * @param {string} userId
   * @param {string} libraryItemId
   * @returns {Promise<KoboReadingState|null>}
   */
  static getForUserItem(userId, libraryItemId) {
    return this.findOne({ where: { userId, libraryItemId } })
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
        currentBookmark: DataTypes.JSON,
        statusInfo: DataTypes.JSON,
        statistics: DataTypes.JSON,
        lastModified: DataTypes.STRING,
        priorityTimestamp: DataTypes.STRING,
        snapshot: DataTypes.STRING
      },
      {
        sequelize,
        modelName: 'koboReadingState',
        indexes: [
          {
            unique: true,
            fields: ['userId', 'libraryItemId']
          }
        ]
      }
    )

    const { user } = sequelize.models
    user.hasMany(KoboReadingState, {
      onDelete: 'CASCADE'
    })
    KoboReadingState.belongsTo(user)
  }
}

module.exports = KoboReadingState
