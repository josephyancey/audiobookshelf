const { DataTypes, Model } = require('sequelize')
const crypto = require('crypto')

/**
 * A Kobo e-reader paired with a user. The device reaches the server at
 * `/kobo/<token>`, so the token is the only credential it holds; only its hash is stored.
 */
class KoboDevice extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {string} */
    this.name
    /** @type {string} sha256 hex of the URL token */
    this.tokenHash
    /** @type {string[]|null} Libraries to sync, null means every library the user can access */
    this.libraryIds
    /** @type {boolean} Only sync books in collectionIds */
    this.onlyCollections
    /** @type {string[]} Collections to sync when onlyCollections is set */
    this.collectionIds
    /** @type {Date} */
    this.lastSyncAt
    /** @type {UUIDV4} */
    this.userId
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt

    // Expanded properties

    /** @type {import('./User')} */
    this.user
  }

  /**
   * Same shape as Calibre-Web: 32 lowercase hex characters
   * @returns {string}
   */
  static generateToken() {
    return crypto.randomBytes(16).toString('hex')
  }

  /**
   * @param {string} token
   * @returns {string}
   */
  static hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex')
  }

  /**
   * @param {string} token
   * @returns {Promise<KoboDevice|null>}
   */
  static async findByToken(token) {
    if (!token || !/^[0-9a-f]{32}$/.test(token)) return null
    return this.findOne({ where: { tokenHash: this.hashToken(token) } })
  }

  /**
   * @param {import('./User')} user
   * @returns {Promise<KoboDevice[]>}
   */
  static getForUser(user) {
    return this.findAll({ where: { userId: user.id }, order: [['createdAt', 'ASC']] })
  }

  /**
   * Libraries this device syncs, limited to what the user can access
   * @param {import('./User')} user
   * @param {string[]} allLibraryIds
   * @returns {string[]}
   */
  getLibraryIdsToSync(user, allLibraryIds) {
    const wanted = Array.isArray(this.libraryIds) && this.libraryIds.length ? this.libraryIds : allLibraryIds
    return wanted.filter((libraryId) => allLibraryIds.includes(libraryId) && user.checkCanAccessLibrary(libraryId))
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      libraryIds: Array.isArray(this.libraryIds) && this.libraryIds.length ? this.libraryIds : null,
      onlyCollections: !!this.onlyCollections,
      collectionIds: Array.isArray(this.collectionIds) ? this.collectionIds : [],
      lastSyncAt: this.lastSyncAt?.valueOf() || null,
      createdAt: this.createdAt?.valueOf() || null
    }
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
        lastSyncAt: DataTypes.DATE
      },
      {
        sequelize,
        modelName: 'koboDevice'
      }
    )

    const { user } = sequelize.models
    user.hasMany(KoboDevice, {
      onDelete: 'CASCADE'
    })
    KoboDevice.belongsTo(user)
  }
}

module.exports = KoboDevice
