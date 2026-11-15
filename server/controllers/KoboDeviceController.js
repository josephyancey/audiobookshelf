const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const KoboSyncManager = require('../managers/KoboSyncManager')
const htmlSanitizer = require('../utils/htmlSanitizer')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/KoboDevice')} koboDevice
 *
 * @typedef {RequestWithUser & RequestEntityObject} KoboDeviceControllerRequest
 */

/**
 * Validate the editable fields of a device
 *
 * @param {Object} body
 * @param {boolean} isCreate
 * @returns {{ values?: Object, error?: string }}
 */
function parseDeviceBody(body, isCreate) {
  const values = {}
  if (!body || typeof body !== 'object') return { error: 'Invalid request body' }

  if (body.name !== undefined || isCreate) {
    const name = htmlSanitizer.stripAllTags(String(body.name || '')).trim()
    if (!name) return { error: 'Device name is required' }
    values.name = name.slice(0, 100)
  }
  if (body.libraryIds !== undefined) {
    if (body.libraryIds !== null && (!Array.isArray(body.libraryIds) || body.libraryIds.some((id) => typeof id !== 'string'))) {
      return { error: 'libraryIds must be an array of strings or null' }
    }
    values.libraryIds = body.libraryIds?.length ? [...new Set(body.libraryIds)] : null
  }
  if (body.onlyCollections !== undefined) {
    if (typeof body.onlyCollections !== 'boolean') return { error: 'onlyCollections must be a boolean' }
    values.onlyCollections = body.onlyCollections
  }
  if (body.collectionIds !== undefined) {
    if (!Array.isArray(body.collectionIds) || body.collectionIds.some((id) => typeof id !== 'string')) {
      return { error: 'collectionIds must be an array of strings' }
    }
    values.collectionIds = [...new Set(body.collectionIds)]
  }
  return { values }
}

class KoboDeviceController {
  constructor() {}

  /**
   * GET: /api/me/kobo-devices
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async findAll(req, res) {
    const devices = await Database.koboDeviceModel.getForUser(req.user)
    res.json({ devices: devices.map((device) => device.toJSON()) })
  }

  /**
   * POST: /api/me/kobo-devices
   * The api_endpoint is only returned here and on token regeneration; only its hash is stored
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async create(req, res) {
    const { values, error } = parseDeviceBody(req.body, true)
    if (error) return res.status(400).send(error)

    const token = Database.koboDeviceModel.generateToken()
    const device = await Database.koboDeviceModel.create({
      ...values,
      tokenHash: Database.koboDeviceModel.hashToken(token),
      userId: req.user.id
    })
    Logger.info(`[KoboDeviceController] User "${req.user.username}" added Kobo device "${device.name}"`)
    res.json({ device: device.toJSON(), apiEndpoint: KoboSyncManager.getDeviceUrl(req, token) })
  }

  /**
   * PATCH: /api/me/kobo-devices/:id
   *
   * @param {KoboDeviceControllerRequest} req
   * @param {Response} res
   */
  async update(req, res) {
    const { values, error } = parseDeviceBody(req.body, false)
    if (error) return res.status(400).send(error)
    await req.koboDevice.update(values)
    res.json({ device: req.koboDevice.toJSON() })
  }

  /**
   * POST: /api/me/kobo-devices/:id/token
   * A new api_endpoint; the old one stops working immediately
   *
   * @param {KoboDeviceControllerRequest} req
   * @param {Response} res
   */
  async regenerateToken(req, res) {
    const token = Database.koboDeviceModel.generateToken()
    await req.koboDevice.update({ tokenHash: Database.koboDeviceModel.hashToken(token) })
    Logger.info(`[KoboDeviceController] User "${req.user.username}" regenerated the token for Kobo device "${req.koboDevice.name}"`)
    res.json({ apiEndpoint: KoboSyncManager.getDeviceUrl(req, token) })
  }

  /**
   * POST: /api/me/kobo-devices/:id/resync
   *
   * @param {KoboDeviceControllerRequest} req
   * @param {Response} res
   */
  async resync(req, res) {
    await KoboSyncManager.resetDevice(req.koboDevice)
    res.sendStatus(200)
  }

  /**
   * DELETE: /api/me/kobo-devices/:id
   *
   * @param {KoboDeviceControllerRequest} req
   * @param {Response} res
   */
  async delete(req, res) {
    Logger.info(`[KoboDeviceController] User "${req.user.username}" removed Kobo device "${req.koboDevice.name}"`)
    await req.koboDevice.destroy()
    res.sendStatus(200)
  }

  /**
   * Kobo sync must be on and the user must be able to download
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    if (!Database.serverSettings.koboSyncEnabled) {
      return res.status(403).send('Kobo sync is disabled')
    }
    if (!req.user.canDownload) {
      return res.status(403).send('User does not have download permission')
    }
    if (req.params.id) {
      const koboDevice = await Database.koboDeviceModel.findOne({ where: { id: req.params.id, userId: req.user.id } })
      if (!koboDevice) return res.sendStatus(404)
      req.koboDevice = koboDevice
    }
    next()
  }
}
module.exports = new KoboDeviceController()
