# ABS conventions reference (for the Kobo sync feature)

Investigated on branch `kobo-sync` at `1eb5b9f1` (package version `2.37.2`). All paths are relative to the repo root. This is a reference for writing code that looks native to ABS; it contains no feature code.

---

## 1. Repo layout, build, Docker, tooling

| Path | What |
| --- | --- |
| `index.js` | Entry. Parses CLI args, loads `dev.js` (gitignored) in dev, sets `global.appRoot`, constructs `server/Server.js`. |
| `prod.js` | Packaged (pkg) entry. |
| `server/` | Express + Sequelize backend (CommonJS `.js`, **no TypeScript source**). |
| `server/routers/` | `ApiRouter.js` (`/api`), `HlsRouter.js` (`/hls`), `PublicRouter.js` (`/public`). |
| `server/controllers/` | One singleton per resource (`module.exports = new XController()`). |
| `server/managers/` | Long-lived services (`CacheManager`, `RssFeedManager`, `ShareManager`, `EmailManager`, `BinaryManager`, `MigrationManager`, ...). |
| `server/models/` | Sequelize models, one class per file. |
| `server/objects/` | Legacy plain objects, incl. `objects/settings/{ServerSettings,EmailSettings,NotificationSettings}.js`. |
| `server/migrations/` | Umzug migrations + `readme.md` + `changelog.md`. |
| `server/utils/` | Helpers; `utils/queries/*` hold the heavy query builders. |
| `server/libs/` | **Vendored** third-party libs (`jsonwebtoken`, `umzug`, `fsExtra`, `nodeStreamZip`, `archiver`, `fluentFfmpeg`, `uaParser`, `which`, `xml`, `rss`, ...). ABS prefers vendoring small libs to adding npm deps. Excluded from eslint. |
| `client/` | Nuxt 2 / Vue 2 SPA, Tailwind 4 (`client/package.json`: `nuxt ^2.18.1`, `@nuxtjs/axios`, `nuxt-socket-io`, `vue-toastification`). Built with `nuxt generate` to `client/dist`, served statically by Express. |
| `test/server/**` | Mocha tests mirroring `server/` layout. |
| `docs/` | OpenAPI spec (`root.yaml`, `controllers/*.yaml`, `objects/**`, bundled `openapi.json`; see `docs/README.md`). |
| `build/` | `linuxpackager` + `debian/` packaging (debian `control` declares no `Depends:`; ffmpeg comes via BinaryManager). |

### Build (note: this fork compiles the server with `tsc`)

`package.json` scripts:

```json
"build:server": "tsc -p tsconfig.server.json",
"dev": "nodemon --watch server --watch index.js --watch test --watch dev.js --ext js,ts --exec \"npm run build:server && node dist-server/index.js\" -- --dev",
"start": "node dist-server/index.js",
"test": "npm run build:server && mocha dist-server/test",
"lint": "eslint ."
```

`tsconfig.server.json`: `allowJs: true`, `strict: true`, **no `checkJs`** (so JS is transpiled, not type-checked), `target ES2022`, `module commonjs`, `outDir dist-server`, `noEmitOnError`, includes `index.js, dev.js, server/**/*.{js,ts}, test/**/*.{js,ts}`. Output mirrors source: `dist-server/server/...`, `dist-server/test/...`. `global.appRoot` is resolved to the repo root when running from `dist-server`. pkg assets include `dist-server/server/migrations/*.js` (migrations are copied at runtime from `__dirname/../migrations`).

Implications: new server files must be `.js` (or `.ts`) under `server/`; non-JS assets that must ship in `dist-server` are NOT copied by tsc (resolveJsonModule only handles `require`d JSON).

### Node version

Node 24 everywhere: Dockerfile `node:24-alpine`, CI `actions/setup-node` `node-version: 24`, pkg target `node24-win-x64`. `@types/node ^24`.

### Dockerfile (multi-stage) and binaries

```dockerfile
FROM node:24-alpine AS build-client          # npm ci && npm run generate
FROM --platform=$BUILDPLATFORM node:24-alpine AS compile-server   # npm ci --include=dev --ignore-scripts && npm run build:server
FROM node:24-alpine AS build-server          # apk add curl make python3 g++ unzip; downloads libnusqlite3 per $TARGETPLATFORM; npm ci --omit=dev
FROM node:24-alpine                           # runtime
RUN apk add --no-cache --update tzdata ffmpeg tini
...
ENV NUSQLITE3_DIR=${NUSQLITE3_DIR}
ENV NUSQLITE3_PATH=${NUSQLITE3_PATH}
CMD ["node", "dist-server/index.js"]
```

Two binary-bundling patterns exist:

1. **Docker**: system package (`apk add ffmpeg`) or a per-arch download in the `build-server` stage, keyed on `$TARGETPLATFORM` (`linux/amd64`, `linux/arm64`), copied into the runtime stage, path exported via `ENV`. libnusqlite3 is the exact template for a downloaded GitHub release binary:

   ```dockerfile
   RUN case "$TARGETPLATFORM" in \
     "linux/amd64") curl -L -o /tmp/library.zip "https://github.com/mikiher/nunicode-sqlite/releases/download/v1.2/libnusqlite3-linux-musl-x64.zip" ;; \
     "linux/arm64") curl -L -o /tmp/library.zip ".../libnusqlite3-linux-musl-arm64.zip" ;; \
     *) echo "Unsupported platform: $TARGETPLATFORM" && exit 1 ;; \
     esac && unzip /tmp/library.zip -d $NUSQLITE3_DIR && rm /tmp/library.zip
   ```

   kepubify publishes plain (un-zipped) static binaries (`kepubify-linux-64bit`, `kepubify-linux-arm64`), so `curl -L -o /usr/local/bin/kepubify ... && chmod +x` in the same `case` shape fits, with `ENV KEPUBIFY_PATH=...`.

2. **Non-docker** (`server/managers/BinaryManager.js`): `Server.init()` calls `binaryManager.init()` only when `global.Source !== 'docker'`. Each binary is a `Binary(name, type, envVariable, validVersions, source, required)`; lookup order is env var -> `which` on PATH -> `mainInstallDir` (exe dir under pkg, else `global.appRoot`) -> `global.ConfigPath`; missing ones are downloaded by a `ZippedAssetDownloader` subclass (`FFBinariesDownloader`, `NunicodeDownloader`) and the env var is set (`process.env[binary.envVariable] = binaryPath`). Version validation for executables runs `"<path>" -version` and regex `version\s([\d\.]+)` (kepubify uses `--version` and prints `kepubify vX.Y.Z`, so a kepubify Binary needs its own version check or a new `type`). `required = false` means startup continues if missing (libnusqlite3 precedent). `SKIP_BINARIES_CHECK=1` skips all checks. `.gitignore` already ignores `/ffmpeg* /ffprobe* /libnusqlite3*` at root: add `/kepubify*`.

   ```js
   defaultRequiredBinaries = [
     new Binary('ffmpeg', 'executable', 'FFMPEG_PATH', ['5.1'], ffbinaries),
     new Binary('ffprobe', 'executable', 'FFPROBE_PATH', ['5.1'], ffbinaries),
     new Binary('libnusqlite3', 'library', 'NUSQLITE3_PATH', ['1.2'], nunicode, false)
   ]
   ```

   `index.js` maps `dev.js` keys to env (`FFmpegPath -> FFMPEG_PATH`, `NunicodePath -> NUSQLITE3_PATH`, `SkipBinariesCheck`); a `KepubifyPath` would follow that pattern.

### Lint / format

- `eslint.config.mjs` (flat config, eslint 10): only correctness rules (`no-undef`, `no-redeclare`, `no-dupe-keys`, `no-dupe-class-members`, `no-global-assign`), CommonJS, explicit node globals list (`Buffer`, `URL`, `process`, `setTimeout`, ... ). **A new global (e.g. `fetch`, `crypto`, `AbortSignal`) must be added to `nodeGlobals` or required explicitly**, otherwise `no-undef` fails CI. Ignores `client/**`, `server/libs/**`, `dist-server/**`.
- `.prettierrc`: `semi: false`, `singleQuote: true`, `printWidth: 400`, `trailingComma: "none"`. Long single-line statements are normal.
- `.editorconfig`: 2-space indent, LF, final newline.

---

## 2. Server architecture

### Startup (`server/Server.js`)

`constructor` sets globals (`global.ConfigPath`, `global.MetadataPath`, `global.RouterBasePath`, `global.XAccel`, ...), creates `this.auth = new Auth()`, managers, and routers:

```js
this.apiRouter = new ApiRouter(this)
this.hlsRouter = new HlsRouter(this.auth, this.playbackSessionManager)
this.publicRouter = new PublicRouter(this.playbackSessionManager)
```

`init()`: binaryManager (non-docker) -> `Database.init(false)` -> token secret -> logs -> `cleanUserData()` -> `CacheManager.ensureCachePaths()` -> `ShareManager.init()`, `backupManager.init()`, `RssFeedManager.init()` -> cron -> watcher.

`start()` builds the express app: CORS/security headers, `cookieParser`, `express-session`, passport, then a base-path rewriting middleware, then:

```js
router.use(express.urlencoded({ extended: true, limit: '5mb' }))
router.use(/^(?!\/internal-api).*/, express.json({ limit: '10mb' }))

router.use('/api', this.auth.ifAuthNeeded(this.authMiddleware.bind(this)), this.apiRouter.router)
router.use('/hls', this.hlsRouter.router)
router.use('/public', this.publicRouter.router)

// RSS Feed temp route
router.get('/feed/:slug', (req, res) => { RssFeedManager.getFeed(req, res) })
router.get('/feed/:slug/cover*', ...)
router.get('/feed/:slug/item/:episodeId/*', ...)

await this.auth.initAuthRoutes(router)   // /login, /auth/refresh, /logout, /auth/openid...
router.post('/init', ...); router.get('/status', ...); router.get('/ping', ...); router.get('/healthcheck', ...)
// then static client + SPA dynamic routes (dynamicRoutes array) or React client catch-all
```

Base path: `ROUTER_BASE_PATH` defaults to **`/audiobookshelf`** (`index.js`). The rewrite middleware prepends `global.RouterBasePath` when a request does not already start with it, so routes work both with and without the prefix; `req.originalHostPrefix` = `${origin}${prefix}` and is what RSS uses to build absolute URLs (`feed.buildXml(req.originalHostPrefix)`). Origin is derived by `server/utils/requestUtils.js#getRequestOrigin` (honours `x-forwarded-proto`). A Kobo router that must emit absolute URLs should use `req.originalHostPrefix`.

**A new top-level router** (e.g. `/kobo/:token/...`) is mounted like `/public` or `/hls`: a class in `server/routers/` exposing `this.router = express()` + `this.router.disable('x-powered-by')` + `init()`, constructed in the `Server` constructor and mounted in `start()` **before** the SPA static/catch-all and **without** the `/api` auth middleware. Order matters only relative to the client catch-all. Note: the global `express.json({limit:'10mb'})` already parses JSON for every non-`/internal-api` route. If a new path should appear in the client SPA `dynamicRoutes`, it must not collide.

### Router pattern

```js
class PublicRouter {
  constructor(playbackSessionManager) {
    /** @type {import('../managers/PlaybackSessionManager')} */
    this.playbackSessionManager = playbackSessionManager
    this.router = express()
    this.router.disable('x-powered-by')
    this.init()
  }
  init() {
    this.router.get('/share/:slug', ShareController.getMediaItemShareBySlug.bind(this))
    this.router.patch('/share/:slug/progress', ShareController.updateMediaItemShareProgress.bind(this))
  }
}
```

Handlers are controller methods **bound to the router instance** (`.bind(this)`), so inside a controller `this` is the router (JSDoc `@this {import('../routers/ApiRouter')}`); managers are reached via `this.playbackSessionManager`, `this.emailManager`, `this.auth`, etc. Per-resource middleware is a controller method chained first: `LibraryItemController.middleware.bind(this), LibraryItemController.getEBookFile.bind(this)`. ApiRouter groups routes under `//\n// Xxx Routes\n//` comment headers.

### Controllers

- File `server/controllers/XxxController.js`, `class XxxController { constructor() {} ... }`, `module.exports = new XxxController()`.
- Each handler has a JSDoc header with verb+path, e.g. `/** \n * PATCH: /api/me/progress/:libraryItemId/:episodeId? \n * @param {RequestWithUser} req \n * @param {Response} res \n */`.
- Shared typedef at the top of each controller:

  ```js
  /**
   * @typedef RequestUserObject
   * @property {import('../models/User')} user
   *
   * @typedef {Request & RequestUserObject} RequestWithUser
   */
  ```

- `middleware(req, res, next)` methods load the entity onto `req` (`req.libraryItem`, `req.libraryFile`, `req.reqUser`) and enforce permissions; `adminMiddleware` returns 403/404 for non-admins.

### Auth (`server/Auth.js`, `server/auth/TokenManager.js`)

- Passport JWT strategy is the only API auth: `ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), ExtractJwt.fromUrlQueryParameter('token')])`, `ignoreExpiration: true`, verify = `tokenManager.jwtAuthCheck`.
- `jwtAuthCheck` handles two payload types: `type: 'api'` (API key: loads `Database.apiKeyModel.getById(keyId)`, checks `isActive`/`exp`, then `Database.userModel.getUserById(apiKey.userId)`, rejects `!user.isActive`) and access tokens (`TokenManager.isBearerAccessTokenPayload`, exp check, `getUserByIdOrOldId`). On success passport sets **`req.user` = Sequelize `User` instance** (with `mediaProgresses` loaded and cached in an LRU `userCache`).
- `/api` is protected by `this.auth.ifAuthNeeded(this.authMiddleware)`; `authNotNeeded` only exempts `GET /api/items/:id/cover` and `GET /api/authors/:id/image` (regexes in `Auth.constructor().ignorePatterns`).
- Public routes (`/public/*`, `/feed/*`, `/hls/*`) are simply mounted without the middleware and do their own lookup: RSS by unguessable `slug` (`Database.feedModel.findOne({ where: { slug } })`), shares by slug via in-memory `ShareManager.findBySlug(slug)` + `share_session_id` cookie, HLS by stream id. **There is no existing "token in the URL path" router**; the closest are RSS slug feeds and share slugs. A Kobo `/kobo/:authToken/...` router must resolve the token itself to a user (`Database.userModel.getUserById(...)`, reject `!user.isActive`), set `req.user` so the rest of the code (e.g. `req.user.checkCanAccessLibraryItem`, `req.user.createUpdateMediaProgressFromPayload`) works unchanged.
- Rate limiting: `this.auth.authRateLimiter` (from `server/utils/rateLimiterFactory.js`) is attached to auth-sensitive routes (`/login`, `/auth/refresh`, `PATCH /api/me/password`).
- Token generation precedent: API keys are JWTs signed with `TokenManager.TokenSecret` (`ApiKey.generateApiKey(tokenSecret, keyId, name, expiresIn)`), shown only once on creation (`ApiKeyController.create` returns `{ apiKey: { apiKey, ...instance.toJSON() } }`). IDs use `require('uuid').v4` (uuid and jsonwebtoken are transitive deps present in `package-lock.json`, not declared in `package.json`; `server/libs/jsonwebtoken` is also vendored). For an opaque random token, Node's built-in `crypto.randomBytes` needs `require('crypto')` (not a declared eslint global).

### Permission checks on `req.user` (`server/models/User.js`)

Getters: `isRoot`, `isAdminOrUp`, `isUser`, `isGuest`, `canDownload`, `canUpdate`, `canDelete`, `canUpload`, `canAccessExplicitContent`. Methods: `checkCanAccessLibrary(libraryId)`, `checkCanAccessLibraryItemWithTags(tags)`, `checkCanAccessLibraryItem(libraryItem)` (needs `libraryItem.libraryId` and `libraryItem.media.{explicit,tags}`). Permission keys live in `user.permissions` JSON: `download, update, delete, upload, createEreader, accessAllLibraries, accessAllTags, accessExplicitContent, selectedTagsNotAccessible, librariesAccessible[], itemTagsSelected[]` (`createEreader` defaults true only for root/admin). Typical denial:

```js
if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
  Logger.error(`[MeController] User "${req.user.username}" attempted to create bookmark for library item "${req.params.id}" without access`)
  return res.sendStatus(403)
}
```

---

## 3. Data layer

### `server/Database.js`

Singleton (`module.exports = new Database()`). Typed model getters:

```js
/** @type {typeof import('./models/MediaItemShare')} */
get mediaItemShareModel() { return this.models.mediaItemShare }
```

`init(force)`: connect -> `MigrationManager.init(version)` + `runMigrations()` -> `buildModels(force)` -> `addTriggers()` -> `loadData()` (settings) -> `ANALYZE`.

```js
buildModels(force = false) {
  require('./models/User').init(this.sequelize)
  ...
  require('./models/MediaItemShare').init(this.sequelize)
  return this.sequelize.sync({ force, alter: false })
}
```

Adding a model = new file + one `require(...).init(this.sequelize)` line **after the models it associates with** + a typed getter. `sync({ alter: false })` creates **missing tables** on every start (so new tables appear even without a migration) but never alters existing ones; upstream nevertheless ships a create-table migration for new tables (v2.26.0 created `sessions`, `apiKeys`) so FK constraints/indices match.

Settings persistence: `Database.serverSettings`, `Database.emailSettings`, `Database.notificationSettings` (objects), saved via `Database.updateSetting(obj)` -> `settingModel.updateSettingObj(obj.toJSON())` (upsert by `id`). `Database.updateServerSettings()` also refreshes `global.ServerSettings`.

### Model definition style (e.g. `server/models/ApiKey.js`, `MediaItemShare.js`)

```js
const { DataTypes, Model } = require('sequelize')

class ApiKey extends Model {
  constructor(values, options) {
    super(values, options)
    /** @type {UUIDV4} */
    this.id
    /** @type {string} */
    this.name
    ...
    // Expanded properties
    /** @type {import('./User').User} */
    this.user
  }

  static async getById(apiKeyId) { ... }   // static query helpers live on the model

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING, allowNull: false },
        description: DataTypes.TEXT,
        expiresAt: DataTypes.DATE,
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        permissions: DataTypes.JSON
      },
      { sequelize, modelName: 'apiKey' }   // table name = pluralized: apiKeys
    )
    const { user } = sequelize.models
    user.hasMany(ApiKey, { onDelete: 'CASCADE' })
    ApiKey.belongsTo(user)
  }
}
module.exports = ApiKey
```

Conventions: UUID PKs, camelCase `modelName` (table auto-pluralized, e.g. `mediaProgresses`, `mediaItemShares`), timestamps on by default (`createdAt`/`updatedAt`), JSON columns for flexible data (`extraData`), `indexes: [...]` in options, associations declared inside the dependent model's `init`, `onDelete: 'CASCADE'` for user-owned rows. Polymorphic media links use `mediaItemId` + `mediaItemType` with `constraints: false` and an `afterFind` hook that sets `instance.mediaItem` (see `MediaProgress`, `MediaItemShare`, `PlaylistMediaItem`). Caching models (User, ApiKey) override `update/save/destroy` to invalidate an `lru-cache`.

Note: a model named `device` already exists (`server/models/Device.js`, playback client devices, `user.hasMany(Device)`), so a Kobo device model needs a distinct name (e.g. `koboDevice`).

### Migrations (`server/migrations/`, `server/managers/MigrationManager.js`)

- Filename: `v<server_version>-<kebab-name>.js` (e.g. `v2.26.0-create-auth-tables.js`). Exports `{ up, down }`, each `async ({ context: { queryInterface, logger } })`. Must be idempotent (`queryInterface.tableExists`, `describeTable` checks).
- Template header:

  ```js
  /**
   * @typedef MigrationContext
   * @property {import('sequelize').QueryInterface} queryInterface - a suquelize QueryInterface object.
   * @property {import('../Logger')} logger - a Logger object.
   *
   * @typedef MigrationOptions
   * @property {MigrationContext} context - an object containing the migration context.
   */
  const migrationVersion = '2.26.0'
  const migrationName = `${migrationVersion}-create-auth-tables`
  const loggerPrefix = `[${migrationVersion} migration]`

  async function up({ context: { queryInterface, logger } }) {
    logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)
    if (await queryInterface.tableExists('sessions')) {
      logger.info(`${loggerPrefix} table "sessions" already exists`)
    } else {
      const DataTypes = queryInterface.sequelize.Sequelize.DataTypes
      await queryInterface.createTable('sessions', { id: {...}, ..., createdAt: { type: DataTypes.DATE, allowNull: false }, updatedAt: {...},
        userId: { type: DataTypes.UUID, references: { model: { tableName: 'users' }, key: 'id' }, allowNull: false, onDelete: 'CASCADE' } })
    }
    logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
  }
  // down: DOWNGRADE BEGIN / dropTable / DOWNGRADE END
  module.exports = { up, down }
  ```

- How they run: version-gated. `migrationsMeta` table stores `version` and `maxVersion`. On a **new** DB migrations are skipped (tables come from `sync`). On an existing DB, migrations run only when `package.json` `version` differs from the stored DB version: `up` runs migrations with `dbVersion < v <= serverVersion` not already executed; downgrade runs `down`s in reverse. A backup `absdatabase.backup.sqlite` is taken; on failure the DB is restored and the process exits. Migration files are copied to `<config>/migrations` so downgrades can find them.
- **Fork implication**: a migration only runs if its version is `> stored DB version` and `<= package.json version`. The fork must bump `package.json` (and `client/package.json`) version to at least the migration's version (e.g. `2.37.3`/`2.38.0`), and pick a version that will not collide with a future upstream migration of the same version (the name suffix keeps them distinct; ordering is by semver only).
- Record each migration in `server/migrations/changelog.md` (table: Server Version | Migration Script Name | Description). Note upstream stopped updating it after v2.20.0 (v2.26.0, v2.33.0, v2.35.0 are missing), but `readme.md` still requires it.

### Media progress

Model `server/models/MediaProgress.js` (table `mediaProgresses`): `id, mediaItemId, mediaItemType ('book'|'podcastEpisode'), duration, currentTime, isFinished, hideFromContinueListening, ebookLocation (STRING), ebookProgress (FLOAT 0..1), finishedAt, extraData JSON {libraryItemId, progress}, podcastId, userId, createdAt, updatedAt`. Indexes `updatedAt` and `(userId, mediaItemId, isFinished, currentTime)`. There is **no `lastUpdate` column**: `getOldMediaProgress()` maps `lastUpdate: this.updatedAt.valueOf()`, `startedAt: this.createdAt.valueOf()`. ebook progress for the web reader is stored as `ebookLocation` (epub CFI string) + `ebookProgress` (fraction).

Update path for `PATCH /api/me/progress/:libraryItemId/:episodeId?`:

```js
// server/controllers/MeController.js
async createUpdateMediaProgress(req, res) {
  const progressUpdatePayload = { ...req.body, libraryItemId: req.params.libraryItemId, episodeId: req.params.episodeId }
  const mediaProgressResponse = await req.user.createUpdateMediaProgressFromPayload(progressUpdatePayload)
  if (mediaProgressResponse.error) {
    return res.status(mediaProgressResponse.statusCode || 400).send(mediaProgressResponse.error)
  }
  SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
  res.sendStatus(200)
}
```

`User#createUpdateMediaProgressFromPayload(payload)` (`server/models/User.js` ~line 730; payload typedef `ProgressUpdatePayload`: `libraryItemId, episodeId?, duration?, progress?, currentTime?, isFinished?, hideFromContinueListening?, ebookLocation?, ebookProgress?, finishedAt?, lastUpdate?, markAsFinishedTimeRemaining?, markAsFinishedPercentComplete?`):

1. Loads the library item + book + this user's `mediaProgresses`; returns `{ error, statusCode }` for 404 (not found), 400 (not a book / episode mismatch), **403 (`!this.checkCanAccessLibraryItem`)**.
2. Existing row -> `mediaProgress.applyProgressUpdate(payload)` (handles isFinished transitions, `finishedAt`, `extraData.progress`, auto-finish thresholds, and **`lastUpdate` -> manually overrides `updatedAt`** "for local sync"); new row -> `mediaProgress.create({...})`.
3. Keeps `this.mediaProgresses` in sync and invalidates the user cache. Returns `{ mediaProgress }`.

It does **not** emit socket events itself; callers do. Events emitted on progress change:

- `PATCH /api/me/progress/...` and `PATCH /api/me/progress/batch/update`: `SocketAuthority.clientEmitter(user.id, 'user_updated', user.toOldJSONForBrowser())`.
- Playback session sync (`server/managers/PlaybackSessionManager.js` ~265 and ~402): `SocketAuthority.clientEmitter(user.id, 'user_item_progress_updated', { id: mp.id, sessionId: session.id, deviceDescription: session.deviceDescription, data: mp.getOldMediaProgress() })`.

The web client listens to both in `client/layouts/default.vue` (`user_updated` -> `user/setUser`; `user_item_progress_updated` -> `user/updateMediaProgress` keyed by `payload.id`/`payload.data`, plus a multi-session warning if that item is currently streaming and `sessionId` differs). For Kobo-originated progress, the closest-native approach is to call `user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation, ebookProgress, isFinished, lastUpdate })` and then emit the same `user_updated` event the PATCH route emits (optionally also `user_item_progress_updated` with `sessionId: null` and a `deviceDescription` like "Kobo").

### Library items, books, ebook files, collections

- `libraryItem` (`server/models/LibraryItem.js`): `id, ino, path, relPath, mediaId, mediaType ('book'|'podcast'), isFile, isMissing, isInvalid, mtime, ctime, birthtime, size, libraryFiles JSON, extraData JSON, title, titleIgnorePrefix, authorNamesFirstLast, authorNamesLastFirst, libraryId, libraryFolderId, createdAt, updatedAt`. Polymorphic `belongsTo(book|podcast, { foreignKey: 'mediaId', constraints: false })`. `LibraryItem.getExpandedById(id)` loads `libraryItem.media` (book with `authors` and `series` via `bookSeries.sequence`); `getLibraryFileWithIno(ino)`; static `getCoverPath(id)`.
- `book` (`server/models/Book.js`): `title, subtitle, publishedYear, publishedDate, publisher, description, isbn, asin, language, explicit, abridged, coverPath, duration, narrators JSON, audioFiles JSON, ebookFile JSON, chapters, tags, genres`. `ebookFile` is an `EBookFileObject`: `{ ino, ebookFormat, addedAt, updatedAt, metadata: { filename, ext, path, relPath, size, mtimeMs, ctimeMs, birthtimeMs } }`. Getters `authorName`, `authorNameLF` require authors loaded. Supported ebook exts: `server/utils/globals.js` `SupportedEbookTypes: ['epub','pdf','mobi','azw3','cbr','cbz']` (no `kepub`).
- `collection` (`Collection.js`): `id, name, description, libraryId` (**library-scoped, shared by all users**, not per-user); `collectionBook` (`CollectionBook.js`) super-many-to-many with `order`, `createdAt` only. Per-user lists are `playlist` (`userId`, `libraryId`) + `playlistMediaItem` (polymorphic). Kobo "shelves"/tags map more naturally to playlists (per user) or collections (shared), a product decision.
- `bookAuthor`, `bookSeries` join tables; `series`, `author` are library-scoped.

### Efficient queries (`server/utils/queries/*`)

- `libraryItemsBookFilters.getUserPermissionBookWhereQuery(user)` returns `{ bookWhere, replacements }` that encodes explicit/tag permissions as SQL (use it to filter books by user permission in bulk instead of per-item `checkCanAccessLibraryItem`). Library access itself is checked via `user.checkCanAccessLibrary(libraryId)` / `permissions.librariesAccessible`.
- `libraryItemsBookFilters.getFilteredLibraryItems(...)`, `findAndCountAll` (with count cache), `getLibraryItemsForCollection(collection)`; `libraryFilters.getMediaItemsInProgress`, `getMediaFinished`, etc. Raw SQL with `Sequelize.literal` and `json_each(...)` is common; replacements use named `:param` style. `server/utils/profiler.js` / `QUERY_PROFILING` env wrap slow queries.
- For an incremental "changed since" sync, the existing indexes are `libraryItems.createdAt`, `libraryItems.mtime`, `mediaProgresses.updatedAt`; `libraryItems.updatedAt` is not indexed.

---

## 4. Serving files

- `GET /api/items/:id/ebook/:fileid?` -> `LibraryItemController.middleware` (loads `req.libraryItem` via `getExpandedById`, 404 if none, **403 if `!req.user.checkCanAccessLibraryItem`**) -> `getEBookFile`: picks `req.libraryItem.media.ebookFile` (or a supplementary one by ino), then:

  ```js
  if (global.XAccel) {
    const encodedURI = encodeUriPath(global.XAccel + ebookFilePath)
    return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
  }
  await new Promise((resolve, reject) => res.sendFile(ebookFilePath, (error) => (error ? reject(error) : resolve())))
  ```

  Range requests come for free from Express `res.sendFile`/`res.download` (uses `send`, supports `Range`, ETag, Last-Modified). Errors go through `LibraryItemController.handleDownloadError(error, res)`. Note `getEBookFile` does not check `canDownload`; `downloadLibraryFile` does (`if (!req.user.canDownload) return res.sendStatus(403)`). `res.download(path, filename, cb)` sets Content-Disposition.
- Covers: `GET /api/items/:id/cover?width&height&format&raw` (auth-exempt GET) -> `CacheManager.handleCoverCache(res, libraryItemId, { format, width, height })` (`server/managers/CacheManager.js`). Validates `format in ['webp','jpeg','png']`, UUID, positive int dims (controller clamps to 4096), caches at `<metadata>/cache/covers/<id>_<w>[x<h>].<fmt>`, resizes with **ffmpeg** (`server/utils/ffmpegHelpers.js#resizeImage`, `-vf scale=w:h`; no sharp). `format` defaults to webp if `Accept` supports it, else jpeg (Kobo wants jpeg). `CacheManager.purgeCoverCache(id)` on cover change. Cache dirs: `CachePath=<metadata>/cache`, `CoverCachePath`, `ImageCachePath`, `ItemCachePath` (`cache/items`, used by AbMerge/AudioMetadata managers). A kepub conversion cache would naturally be `<metadata>/cache/kepub/` created in `ensureCachePaths()`.
- CORS: Server.js only adds CORS for `/api/items/:id/(ebook|cover)` and configured origins; Kobo device requests are not browser requests so CORS is irrelevant.

---

## 5. Settings and client

### Server-wide settings (`server/objects/settings/ServerSettings.js`)

Plain class with `id = 'server-settings'`, defaults in the constructor, `construct(settings)` that coerces each field (`!!settings.x`, `settings.x || default`), `toJSON()`, `toJSONForBrowser()` (strips secrets), and a `PATCHABLE_SETTINGS_KEYS` Set that whitelists keys for `PATCH /api/settings` (`MiscController.updateServerSettings`, checks `ServerSettings.patchableSettingsKeys.has(key)`; client `pages/config/index.vue` uses `<ui-toggle-switch ... @input="(val) => updateSettingsKey('chromecastEnabled', val)" />`). Adding a server flag = constructor default + `construct` + `toJSON` + (if UI-editable) add to `PATCHABLE_SETTINGS_KEYS`. Read at runtime via `Database.serverSettings.x` or `global.ServerSettings.x`.

### E-reader devices (`server/objects/settings/EmailSettings.js`) - nearest neighbour for Kobo config

Stored in the `email-settings` setting row:

```js
/**
 * @typedef EreaderDeviceObject
 * @property {string} name
 * @property {string} email
 * @property {string} availabilityOption   // 'adminOrUp' | 'userOrUp' | 'guestOrUp' | 'specificUsers'
 * @property {string[]} users
 */
```

- `update(payload)` validates devices (name+email required; bad availability -> `adminOrUp`; `specificUsers` with no users -> `adminOrUp`) and diff-applies with `areEquivalent`/`copyValue`; returns `hasUpdates`.
- `checkUserCanAccessDevice(device, user)`, `getEReaderDevices(user)`, `getEReaderDevice(name)`.
- Admin API: `POST /api/emails/ereader-devices` (`EmailController.updateEReaderDevices`, admin) emits `SocketAuthority.adminEmitter('ereader-devices-updated', { ereaderDevices })`.
- User API: `POST /api/me/ereader-devices` (`MeController.updateUserEReaderDevices`): users with `permissions.createEreader` manage only devices whose `availabilityOption === 'specificUsers'` and `users === [req.user.id]`; emits `SocketAuthority.clientEmitter(req.user.id, 'ereader-devices-updated', {...})`.
- Login payload (`Auth.getUserLoginResponsePayload`) includes `ereaderDevices: Database.emailSettings.getEReaderDevices(user)`; client stores it in `store.libraries.ereaderDevices` (`setEReaderDevices`). Send-to-device is `POST /api/emails/send-ebook-to-device` -> `EmailManager.sendEBookToDevice(ebookFile, device, res)` (nodemailer attachment).
- UI: admin `client/pages/config/email.vue` + `components/modals/emails/EReaderDeviceModal.vue`; user `client/pages/account.vue` "Ereader Devices" section + `components/modals/emails/UserEReaderDeviceModal.vue`.

Because these devices are a JSON blob inside a settings row keyed by name, a Kobo device with a per-device auth token, sync state, and per-device rows is a better fit as **its own Sequelize model** (user `hasMany`, `onDelete: 'CASCADE'`) than as an `ereaderDevices` entry; the UI can sit next to the Ereader Devices section on the account page.

### Per-user settings / tokens

There is no generic per-user settings table. Options in use: `user.extraData` JSON (e.g. `seriesHideFromContinueListening`, `oldUserId`, `authOpenIDSub`) updated via `user.update({ extraData: {...} })` or `user.changed('extraData', true)`; or a dedicated user-owned table (ApiKey, Session, Device, Playlist precedents). User-owned secrets (API keys, refresh sessions) all use dedicated tables.

### Client conventions

- Pages: `client/pages/*.vue` (Nuxt file routing). Admin settings pages in `client/pages/config/*.vue`, listed in `client/components/app/ConfigSideNav.vue` `configRoutes` (`{ id: 'config-email', title: this.$strings.HeaderEmail, path: '/config/email' }`); non-admins only see `config-stats`. Admin page guard:

  ```js
  asyncData({ store, redirect }) {
    if (!store.getters['user/getIsAdminOrUp']) {
      redirect('/')
    }
  }
  ```

  User-facing settings belong on `client/pages/account.vue` (sections separated by `<div class="w-full h-px bg-white/10 my-4" />` and wrapped in `<app-settings-content :header-text="$strings.HeaderX">` with a `#header-items` slot for buttons).
- Components are auto-registered by folder: `components/ui/Btn.vue` -> `<ui-btn>`, `components/modals/emails/UserEReaderDeviceModal.vue` -> `<modals-emails-user-e-reader-device-modal>`, `components/app/SettingsContent.vue` -> `<app-settings-content>`, tables in `components/tables/*` (`<tables-api-keys-table>`). Common UI: `ui-btn` (`color="bg-primary" small`, `:loading`), `ui-icon-btn icon="delete" borderless :size="8"`, `ui-text-input-with-label`, `ui-toggle-switch`, `ui-dropdown`, `ui-tooltip`, `ui-checkbox`; Material Symbols icons via `<span class="material-symbols">`; tables use `class="tracksTable"`.
- Confirm dialogs: `this.$store.commit('globals/setConfirmPrompt', { message: this.$getString('MessageConfirmDeleteDevice', [device.name]), callback: (confirmed) => {...}, type: 'yesNo' })`.
- API calls: `this.$axios.$get/$post/$patch/$delete('/api/...')` (Nuxt axios; plugin `client/plugins/axios.js` adds `Authorization: Bearer <token>` and handles 401 refresh). Pattern:

  ```js
  this.processing = true
  this.$axios
    .$post(`/api/me/ereader-devices`, payload)
    .then((data) => { ... this.$toast.success(this.$strings.ToastXxxSuccess) })
    .catch((error) => {
      console.error('Failed to delete device', error)
      this.$toast.error(this.$strings.ToastRemoveFailed)
    })
    .finally(() => { this.processing = false })
  ```

  Server error strings are surfaced with `error.response?.data` when it is a string.
- Toasts: `vue-toastification` (`client/plugins/toast.js`), `this.$toast.success/error/warning/info(...)`.
- i18n: `client/strings/en-us.json` is the source; keys are **PascalCase with a type prefix** and **sorted alphabetically** (CI `i18n-integration.yml` runs `audiobookshelf-i18n-updater` to verify). Prefixes by frequency: `Label*` (516), `Message*` (210), `Toast*` (173), `Button*` (117), `Header*` (102), plus `Tooltip*`, `Note*`, `Placeholder*`, `Error*`. Placeholders `{0}`, `{1}` used with `this.$getString('Key', [arg])`; plain use `this.$strings.Key`. Only edit `en-us.json`; other locales are filled by Weblate (missing keys fall back to en-us in `plugins/i18n.js`). Examples: `"ButtonAddDevice": "Add Device"`, `"HeaderEreaderDevices": "Ereader Devices"`, `"MessageNoDevices": "No devices"`, `"ToastDeviceAddFailed": "Failed to add device"`, `"LabelApiKeyCreatedDescription": "Make sure to copy the API key now as you will not be able to see this again."`.
- Socket listeners for the client live in `client/layouts/default.vue` (`this.socket.on('ereader-devices-updated', this.ereaderDevicesUpdated)` etc.).
- Precedent for "show secret once" UI: `client/components/modals/ApiKeyCreatedModal.vue` + `pages/config/api-keys/index.vue`.

---

## 6. Socket events (`server/SocketAuthority.js`)

Singleton. Methods:

- `emitter(evt, data, filter?)` - all authenticated clients (optional user filter).
- `clientEmitter(userId, evt, data)` - all sockets of one user (logs debug if none).
- `adminEmitter(evt, data)` - admin sockets.
- `libraryItemEmitter(evt, libraryItem)` / `libraryItemsEmitter(evt, libraryItems)` - item updates filtered by user access.

Event names are snake_case (`user_updated`, `user_item_progress_updated`, `item_updated`, `collection_updated`) except legacy `ereader-devices-updated`. Progress emissions are described in section 3.

---

## 7. Logging, errors, style

- `const Logger = require('../Logger')`; levels `trace, debug, info, warn, error, fatal, note` (`Logger.isDev` in dev). Message style: **`[ClassName] message`**, quoting user/entity names with `"..."`:

  ```js
  Logger.error(`[LibraryItemController] User "${req.user.username}" without download permission attempted to download file "${libraryFile.metadata.path}"`)
  Logger.warn(`[ApiKeyController] create: Invalid name: ${req.body.name}`)
  Logger.info(`[ApiKeyController] Created API key "${apiKeyInstance.name}"`)
  Logger.error(`[MeController] batchUpdateMediaProgress: ${mediaProgressResponse.error}`)
  ```

  Error objects passed as an extra arg: `Logger.error('[ZippedAssetDownloader] Error extracting files:', error)`.
- Responses: `res.sendStatus(4xx)` for bare status, `res.status(400).send('Plain message')` for client errors with a reason, `res.json(obj)` for success data, `res.sendStatus(200)` for success without body (204 occasionally). Errors are plain text, not JSON (exception: `/auth/refresh` returns `{ error }`). Validate early and `return res...`. Async handlers rely on internal try/catch; there is no global async error wrapper, so uncaught rejections in handlers hit `process.on('unhandledRejection')` which **exits the process**. Wrap risky awaits (file IO, child processes) in try/catch.
- Model-level helpers return `{ error, statusCode }` objects rather than throwing (see `createUpdateMediaProgressFromPayload`).
- JSDoc everywhere: `@param {import('../models/User')} user`, `@returns {Promise<...>}`, `@typedef` blocks, `@this {import('../routers/ApiRouter')}`, `/** @type {X} */ this.field` in constructors. No TS types in source.
- Style: CommonJS `require`, no semicolons, single quotes, 2 spaces, async/await (some older `.then` chains), template literals, `const`/`let` (some legacy `var`). Classes PascalCase; file name = class name (`KoboController.js`, `KoboRouter.js`, `KoboManager.js`); models singular PascalCase file with camelCase `modelName`; utils camelCase files. Singletons export `new X()`; managers needing constructor deps (EmailManager, BinaryManager) export the class and are instantiated in `Server`.

---

## 8. Testing

- Mocha 10 + chai 4 (`expect`) + sinon 17; nyc for coverage. `package.json` `"mocha": { "recursive": true }`.
- Tests are `test/server/<mirror path>/<Name>.test.js`, compiled by tsc to `dist-server/test` and run with `npm test` (= `npm run build:server && mocha dist-server/test`). CI (`.github/workflows/unit-tests.yml`): Node 24, `npm ci`, `npm run lint`, `npm test`. Client component tests are Cypress (`client`, `npm test`).
- Requires use relative paths into `server/`: `require('../../../server/controllers/UserController')`.
- Pure unit (no DB) controller test (`test/server/controllers/UserController.test.js`):

  ```js
  beforeEach(() => { sinon.stub(Logger, 'error') })
  afterEach(() => { sinon.restore() })
  it('rejects deleting the root user by UUID', async () => {
    const fakeRes = { sendStatus: sinon.spy(), json: sinon.spy() }
    await UserController.delete({ user: adminUser, reqUser: rootUser, params: { id: rootUser.id } }, fakeRes)
    expect(fakeRes.sendStatus.calledWith(403)).to.be.true
  })
  ```

- DB-backed test (`test/server/controllers/LibraryItemController.test.js`): in-memory SQLite, real models.

  ```js
  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
    sinon.stub(Logger, 'info')
  })
  afterEach(async () => { sinon.restore(); await Database.sequelize.sync({ force: true }) })
  // create rows: Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' }), libraryFolderModel, bookModel.create({ title, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] }), libraryItemModel.create({ libraryFiles: [], mediaId, mediaType: 'book', libraryId, libraryFolderId })
  // call handlers bound to the router: await LibraryItemController.delete.bind(apiRouter)(fakeReq, fakeRes)
  ```

- Migration tests (`test/server/migrations/*.test.js`): either stub `queryInterface` with sinon (`addColumn`, `tableExists`, `describeTable`, `sequelize.Sequelize.DataTypes`) and assert exact `logger.info` messages (`'[2.17.6 migration] UPGRADE BEGIN: 2.17.6-share-add-isdownloadable'`), or run against `new Sequelize({ dialect: 'sqlite', storage: ':memory:' })` with `sequelize.getQueryInterface()` (`v2.15.0-series-column-unique.test.js`, `v2.17.3-fk-constraints.test.js`). `test/server/migrations/v0.0.1-migration_example.js` + `.test.js` is the canonical example. `MigrationManager.test.js` covers the version logic.
- Binary tests: `test/server/managers/BinaryManager.test.js` uses the exported `Binary`, `ffbinaries`, `nunicode` with sinon stubs.

---

## 9. Structurally similar existing features (templates)

| Need | Best template |
| --- | --- |
| Top-level router outside `/api`, unauthenticated by passport, self-resolving a secret in the URL | `server/routers/PublicRouter.js` + `ShareController` (slug), RSS `/feed/:slug` routes in `Server.start()` + `RssFeedManager.getFeed` (slug lookup, absolute URLs from `req.originalHostPrefix`, XML content type) |
| Per-user secret token, create/list/revoke, shown once | `ApiKey` model + `ApiKeyController` + `pages/config/api-keys` + `ApiKeyCreatedModal.vue`; token resolution in `TokenManager.jwtAuthCheck` (active/expired/user-active checks) |
| User-owned device table | `server/models/Device.js`, `Session.js`, `ApiKey.js` (user `hasMany`, cascade) |
| User-facing device management UI | `client/pages/account.vue` "Ereader Devices" section + `UserEReaderDeviceModal.vue`; `POST /api/me/ereader-devices` |
| Ebook delivery to an e-reader | `EmailController.sendEBookToDevice` / `EmailManager.sendEBookToDevice` (permission checks: device access + `checkCanAccessLibraryItem`; uses `libraryItem.media.ebookFile`) |
| Writing progress from a non-web client | `PlaybackSessionManager` sync paths (call `user.createUpdateMediaProgressFromPayload`, emit `user_item_progress_updated`) and `MeController.batchUpdateMediaProgress` (emit `user_updated`) |
| File streaming with X-Accel support | `LibraryItemController.getEBookFile`, `CacheManager.handleCoverCache` |
| Bundled external binary | `BinaryManager` (`Binary` + downloader) and Dockerfile libnusqlite3 stage |
| New tables migration | `server/migrations/v2.26.0-create-auth-tables.js` |

There is no OPDS implementation in this codebase.

---

## 10. Contribution conventions and feature flags

- No `CONTRIBUTING.md` in repo; `readme.md` links to https://audiobookshelf.org/docs/contributing/general/. PR template (`.github/pull_request_template.md`) sections: Brief summary, Which issue is fixed?, In-depth Description, How have you tested this?, Screenshots (required for web client changes). Use Draft PRs for WIP. All checks must pass (lint + unit tests; i18n alphabetization; OpenAPI lint for `docs/`).
- New/changed endpoints may be documented in `docs/` OpenAPI yaml (only some controllers are covered: Author, Email, Library, Notification, Podcast, Series).
- Feature flags / experimental: no generic flag system. Experimental or opt-in behaviour is gated by **environment variables read in `Server` constructor into globals** (`EXP_PROXY_SUPPORT=1` logs "Experimental Proxy Support Enabled", `ALLOW_CORS`, `USE_X_ACCEL`, `DISABLE_SSRF_REQUEST_FILTER`, `REACT_CLIENT_PATH` "experimental Next.js client", `QUERY_PROFILING`), or by boolean `ServerSettings` fields toggled in `pages/config/index.vue` (e.g. `chromecastEnabled`, `scannerDisableWatcher`). A Kobo feature toggle would most natively be a `ServerSettings` boolean (e.g. `koboSyncEnabled`, admin-toggleable, added to `PATCHABLE_SETTINGS_KEYS`), optionally plus user permission similar to `createEreader`.
