const express = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const requestIp = require('../libs/requestIp')
const RateLimiterFactory = require('../utils/rateLimiterFactory')
const KoboController = require('../controllers/KoboController')

/**
 * Routes a Kobo e-reader calls once its api_endpoint points at `/kobo/<token>`.
 *
 * The token in the path is the device's only credential, because some device requests
 * (downloads, covers) carry no auth headers at all (Calibre-Web kobo_auth.py). It resolves to a
 * paired device and its user; `req.user` is then the same User the rest of the server works with.
 */
class KoboRouter {
  constructor() {
    this.router = express.Router({ mergeParams: true })
    this.init()
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async authMiddleware(req, res, next) {
    if (!Database.serverSettings?.koboSyncEnabled) {
      return res.status(403).send('Kobo sync is disabled')
    }
    try {
      const device = await Database.koboDeviceModel.findByToken(req.params.token)
      const user = device ? await Database.userModel.getUserById(device.userId) : null
      if (!device || !user?.isActive) {
        Logger.warn(`[KoboRouter] Unknown Kobo token from ${requestIp.getClientIp(req) || req.ip}`)
        // Only these count toward the rate limit, not 401s forwarded from the Kobo store
        req.koboAuthFailed = true
        return res.sendStatus(401)
      }
      req.koboDevice = device
      req.user = user
      next()
    } catch (error) {
      Logger.error('[KoboRouter] Failed to authenticate Kobo request', error)
      res.sendStatus(500)
    }
  }

  init() {
    const controller = KoboController
    // Express 4 does not catch rejected handlers, and a hung request stalls the device's sync queue
    const handle = (method) => (req, res, next) =>
      Promise.resolve(controller[method](req, res, next)).catch((error) => {
        Logger.error(`[KoboRouter] ${req.method} ${req.path} failed`, error)
        if (!res.headersSent) res.status(500).send('Internal error')
      })

    this.router.use(RateLimiterFactory.getKoboRateLimiter(), this.authMiddleware.bind(this))

    this.router.get('/', handle('root'))
    this.router.get('/v1/initialization', handle('initialization'))

    this.router.post('/v1/auth/device', handle('auth'))
    this.router.post('/v1/auth/refresh', handle('auth'))
    this.router.post('/v1/user/add-device', handle('auth'))

    this.router.get('/oauth/.well-known/openid-configuration', handle('oauthDiscovery'))
    this.router.all('/oauth/*', handle('oauthToken'))

    this.router.get('/v1/library/sync', handle('sync'))

    // Collections. DELETE on the bare tags path is refused so it can't fall into the item delete (Calibre-Web)
    this.router.post('/v1/library/tags', handle('createTag'))
    this.router.delete('/v1/library/tags', (req, res) => res.sendStatus(405))
    this.router.put('/v1/library/tags/:tagId', handle('renameTag'))
    this.router.delete('/v1/library/tags/:tagId', handle('deleteTag'))
    this.router.post('/v1/library/tags/:tagId/items', handle('addTagItems'))
    this.router.post('/v1/library/tags/:tagId/items/delete', handle('removeTagItems'))

    this.router.get('/v1/library/:itemId/metadata', handle('metadata'))
    this.router.get('/v1/library/:itemId/state', handle('getState'))
    this.router.put('/v1/library/:itemId/state', handle('putState'))
    this.router.delete('/v1/library/:itemId', handle('deleteItem'))

    this.router.get('/download/:itemId/:format', handle('download'))
    this.router.get('/:imageId/:width/:height/:greyscale/image.jpg', handle('cover'))
    this.router.get('/:imageId/:width/:height/:quality/:greyscale/image.jpg', handle('cover'))

    this.router.all('*', handle('fallback'))
  }
}
module.exports = KoboRouter
