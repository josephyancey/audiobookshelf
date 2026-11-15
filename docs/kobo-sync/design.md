# Kobo sync in Audiobookshelf: design

Status: agreed 2026-11-14. Branch `kobo-sync`.

Goal: a stock Kobo e-reader (no KOReader, no mods besides one config line) syncs ebooks and reading progress with Audiobookshelf exactly the way it does with Calibre-Web (CW), while the code reads as native ABS.

Reference docs, both in this folder:

- `calibre-web-reference.md`: CW and CWA behavior, every endpoint and JSON shape, and 32 numbered lessons from their history. "Lesson N" below refers to that list.
- `abs-conventions.md`: how ABS is built. File paths below follow it.

The rule for every decision: **behave like CW on the wire; where CW has a known bug, take the fix (CWA's, or the open upstream PR's), not the bug.**

---

## 1. What the user sees

1. Admin: **Settings → Kobo sync** (new page under `client/pages/config/`). One switch to enable Kobo sync server-wide, one switch "Forward unknown requests to the Kobo store" (on by default), and an optional **public URL** used in every link sent to the device (Lesson 7).
2. User: **Account → Kobo devices**, next to "Ereader devices". "Add device" asks for a name (e.g. "Libra Colour") and which libraries to sync (default: all the user can access). It shows the line to paste into the Kobo once:

   ```
   api_endpoint=https://audiobooks.example.com/kobo/<token>
   ```

   Each device row has: rename, choose libraries, "only sync selected collections" toggle, **Resync everything**, delete.
3. On the Kobo: paste the line into `.kobo/Kobo/Kobo eReader.conf`, eject, tap Sync. Books appear with covers; reading position flows both ways; the Kobo store keeps working.

---

## 2. Server layout (new files)

| File | Role | ABS template |
|---|---|---|
| `server/routers/KoboRouter.js` | Express app mounted at `/kobo/:token`; token → device → user; catch-all | `PublicRouter.js` |
| `server/controllers/KoboController.js` | Device-facing handlers: init, auth stubs, sync, metadata, state, tags, delete, cover, download | `ShareController.js` |
| `server/controllers/KoboDeviceController.js` | User-facing `/api/me/kobo-devices` CRUD + resync (mounted in `ApiRouter`) | `ApiKeyController.js` |
| `server/managers/KoboSyncManager.js` | Builds sync pages; owns delivery state and checkpoints | `RssFeedManager.js` |
| `server/managers/KoboReadingStateManager.js`, `KoboCollectionManager.js` | Reading progress both ways; collection edits from the device | — |
| `server/managers/KoboStoreProxy.js` | Forwarding to `storeapi.kobo.com`, 307 vs server-side proxy | — |
| `server/utils/kobo/syncToken.js` | Encode/decode `x-kobo-synctoken` | — |
| `server/utils/kobo/koboJson.js` | `BookEntitlement`, `BookMetadata`, `ReadingState`, `Tag` builders, timestamp format | — |
| `server/utils/kobo/koboResources.js` | Native `/v1/initialization` resource dict + overrides | — |
| `server/utils/kobo/kepubPosition.js` | KoboSpan ↔ CFI ↔ exact fraction | — |
| `server/managers/KepubManager.js` | On-demand kepubify conversion + cache | `CoverManager` / cache paths |
| `server/models/KoboDevice.js`, `KoboSyncedItem.js`, `KoboReadingState.js`, `KoboSyncedCollection.js` | Data | `ApiKey.js` |
| `server/migrations/v2.38.0-add-kobo-sync-tables.js` | Creates the tables; idempotent | `v2.26.0-create-auth-tables.js` |
| `client/pages/config/kobo.vue`, `client/components/modals/KoboDeviceModal.vue`, section in `client/pages/account.vue` | UI | ereader devices UI |
| `test/server/...` | Mocha tests mirroring the above | existing tests |

`package.json` version bumps to `2.38.0` so the migration runs on existing databases (ABS only runs migrations newer than the DB's stored version). The migration is safe to run twice, so a later rebase onto an upstream `2.38.x` doesn't break.

Style: no semicolons, single quotes, JSDoc on every handler, `Logger.info('[KoboController] ...')`, plain-text error responses, try/catch around every await that can reject.

---

## 3. Data model

All keyed by **device**, not user (Lesson 26: CW's per-user state means a second Kobo gets nothing).

**`koboDevice`**: `id` (uuid), `userId` (cascade), `name`, `tokenHash` (sha256 of the URL token; token shown once, like API keys), `libraryIds` (JSON, null = all accessible), `onlyCollections` (bool), `lastSyncAt`, `lastUserAgent`, `lastIp`, `createdAt/updatedAt`. Token is 32 hex chars from `crypto.randomBytes(16)`, same shape as CW.

**`koboSyncedItem`**: `koboDeviceId`, `libraryItemId` (not a foreign key, so a deleted item can still be removed from the device), the confirmed state (`deliveredAt`, `deliveredVersion`, `deliveredFormat`, `isRemoved`, `removedBy` = `device`|`scope`) and the unconfirmed state (`pendingCheckpoint`, `pendingVersion`, `pendingFormat`, `pendingRemoved`). Unique (`koboDeviceId`, `libraryItemId`). This is CW's `kobo_synced_books`, made per device and confirmed by checkpoint (§5).

**`koboReadingState`**: per user per item, not per device (progress is the user's, as in CW). The raw last `CurrentBookmark`, `StatusInfo`, `Statistics`, the device's own `LastModified`/`PriorityTimestamp` strings, and `progressUpdatedAt` (the media progress it was applied as), so the device's state can be handed back verbatim (Lesson 9c).

**`koboSyncedCollection`**: `koboDeviceId`, `collectionId`, `deliveredHash` (sha1 of name + full book list, because adding a book to an ABS collection doesn't touch the collection's `updatedAt`), `isDeleted`, and the same pending/checkpoint fields. A `DeletedTag` is sent for delivered rows whose collection is gone or out of scope. This replaces the tombstone table first sketched here.

JSON numbers: JavaScript has no int/float distinction, so a `50` from the device always goes back as `50` (Lesson 9a is satisfied by construction).

ABS progress stays the source of truth: `mediaProgress.ebookProgress`, `ebookLocation`, `isFinished`. `koboReadingState` only remembers the Kobo-specific representation so round trips are exact.

---

## 4. Auth and routing

- Mounted in `Server.start()` like `/public`, without the `/api` auth middleware: `router.use('/kobo/:token', this.koboRouter.router)`.
- Token lookup: hash, find `koboDevice`, load user, reject inactive users and devices of disabled feature with **401** (CW behavior). Sets `req.user` and `req.koboDevice`, so `req.user.checkCanAccessLibraryItem` and `createUpdateMediaProgressFromPayload` work unchanged.
- Failed lookups go through `rateLimiterFactory` (Lesson 32: only failed tokens are throttled; a real sync makes dozens of calls a minute).
- Download role: users without `canDownload` get **403 on sync** (CW behavior, Lesson 22). Library access restrictions apply to every lookup.
- **Public base URL** (Lesson 7): every absolute URL sent to the device is built from the admin's public URL setting if set, else `req.originalHostPrefix`. Kobos drop the port from `Host`; the setting is the fix, and the UI warns when the generated `api_endpoint` would be `localhost`.
- **Catch-all** under `/kobo/:token/*` (Lesson 13): forward to the store when the proxy is on, else `{}` 200, and log the path at debug. Unknown endpoints never 404.

---

## 5. Sync (`GET /v1/library/sync`)

The wire format is CW's: base64 JSON in `x-kobo-synctoken` (a **string** header, Lesson 6), pages of at most 100 items, `x-kobo-sync: continue` while more remain, JSON body with `charset=utf-8` (Lesson 21).

**Token contents** (version `1-1-0` shape kept, plus our fields):

```json
{ "version": "1-1-0", "data": {
  "raw_kobo_store_token": "",
  "checkpoint": "<id of the page this token was issued with>",
  "reading_state_last_modified": 0,
  "tags_last_modified": 0 } }
```

- A header containing `.` is a raw store token (first sync after switching from the store): keep it, start fresh. Bad base64/JSON: start fresh, log once. Missing padding tolerated.

**Which items go in a page** (fixes Lessons 1–5 and 2's open truncation bug by not mixing cursors):

1. Scope: library items in the device's libraries that the user can access, with an `ebookFile` of format epub or kepub (pdf/mobi skipped, like CW). In "only selected collections" mode, items in collections flagged for this device.
2. **Pending = in scope and (not in `koboSyncedItem` for this device, or `libraryItem.updatedAt > deliveredItemUpdatedAt`, or cover changed)**, plus **removals = in `koboSyncedItem`, not `removed`, but no longer in scope** (CWA's set-difference fix for removed-from-shelf, Lesson 20/§8).
3. Order by `(updatedAt, id)`, take 101 to know if more remain (Lesson 3).
4. Each emitted row is written with `pendingCheckpoint = <new checkpoint id>`, not yet delivered.
5. **Delivery confirmation** (Lesson 1): when the device next calls sync presenting checkpoint X, all rows with `pendingCheckpoint = X` become delivered. If the device aborted and comes back with an older token, unconfirmed rows are simply pending again and get re-sent. CW marks them sent while building the response; that is the bug that loses books.
6. New vs changed (Lesson 4): `NewEntitlement` if this device has never confirmed the item, else `ChangedEntitlement`. No timestamp guessing.
7. Per-item isolation (Lesson 12): a book whose JSON fails to build is logged and skipped, never 500s the page. Missing dates fall back to `addedAt` → `createdAt` → now; series index to 1 (keeping 0 as 0); language to `en`.

**Reading states in the stream**: `ChangedReadingState` for items whose ABS progress changed since `reading_state_last_modified` (and were not just emitted inside an entitlement this page), capped at 100, ordered by update time (CW behavior).

**Collections → Kobo collections (Tags)**: `NewTag`/`ChangedTag` with the full item list, `DeletedTag` from tombstones (§8). Not paginated (CW behavior).

**Store merge** (proxy on): only on the final local page, call the store's sync with our stored `raw_kobo_store_token`, append its results, keep its new token inside ours, copy `x-kobo-sync`/`x-kobo-sync-mode`/`x-kobo-recent-reads` only when present (CW copies `None`). Timeout 2 s connect / 10 s read; on failure log and send our page alone.

**Resync everything** (device menu): delete that device's `koboSyncedItem` rows; next sync re-sends all as new.

---

## 6. Entitlement and metadata JSON

Field-for-field CW §5.1–5.3, sourced from ABS:

| Kobo field | ABS source |
|---|---|
| ids (`Id`, `RevisionId`, `CrossRevisionId`, `EntitlementId`, `WorkId`) | `libraryItem.id` (uuid) |
| `Title`, `Description`, `Publisher.Name`, `PublicationDate`, `Language` | `book.title`, `description`, `publisher`, `publishedDate`/`publishedYear`, `language` → ISO 639-1 |
| `Contributors`, `ContributorRoles` | `book.authors` (all; no `Role` key) |
| `Series` | first series + `sequence`; `Id` = uuid3(DNS, series name) like CW |
| `CoverImageId` | `<itemId>-<cover version>` (CWA cache-buster, Lesson 19); suffix stripped on request |
| `IsRemoved` | removal per §5.2 / §8 |
| `Created`, `LastModified` | `addedAt`, `updatedAt` |

Timestamps: `YYYY-MM-DDTHH:MM:SSZ`, no fractions, all compared as UTC epoch ms internally (Lesson 28).

**Download URLs** (Lessons 10, 30): KEPUB is offered whenever possible. If the ebook is a kepub, or kepubify is available, one entry `{"Format":"KEPUB","Url":".../download/<itemId>/kepub"}`; otherwise `EPUB3` + `EPUB` entries to the same epub URL. Fixed-layout epubs (`rendition:layout = pre-paginated`) are advertised as `EPUB3FL`. `"DrmType": "None"` (CWA). Size is the real file size.

**Covers**: `/<imageId>/<w>/<h>[/<quality>]/<greyscale>/image.jpg`, parsed leniently (`{height}` literal → small, Lesson 18), JPEG always, through ABS's existing ffmpeg resize cache, three fixed widths. Unknown id: 307 to `cdn.kobo.com/book-images/...` when the proxy is on (store books' covers), else 404.

---

## 7. Reading progress both ways

**Device → ABS** (`PUT /v1/library/<id>/state`):

1. Every key optional (Lesson 11). Never 400 on a missing key.
2. Store the raw `CurrentBookmark`, `StatusInfo`, `Statistics` and the device's `LastModified` in `koboReadingState`, verbatim.
3. Convert to ABS progress with `kepubPosition.js`: KoboSpan → exact fraction + CFI; else chapter + in-chapter percent; else whole-book percent. Requires the same file the device has, i.e. the kepub ABS served it.
4. Call `user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookProgress, ebookLocation, isFinished, lastUpdate })` and emit `user_updated` exactly like `PATCH /api/me/progress`, so the web UI, the apps and BookBridge see it.
5. `Status: Finished` → `isFinished: true`. Reading → not finished. (ABS `isFinished` covers the whole item, audio included; finishing the ebook finishes the item, same as ABS's own reader.)
6. Response: CW's `{"RequestResult":"Success","UpdateResults":[...]}` **without** server-stamped `LastModified`/`PriorityTimestamp` (open PR #3607, Lesson 9c).

**ABS → device** (`GET .../state` and `ChangedReadingState` in sync):

1. If ABS progress hasn't changed since the stored Kobo bookmark, return the stored Kobo state **verbatim**, numbers exactly as received (int stays int, Lesson 9a/b). This is what stops "Return to last page read?" popups.
2. If ABS progress is newer (web reader, phone app, BookBridge moved it from the audiobook), build a new bookmark: CFI → chapter + character → the KoboSpan at or before it (`Location: {Source, Type:"KoboSpan", Value}`), plus `ProgressPercent` (integer, like the device) and `ContentSourceProgressPercent`. `LastModified` = PriorityTimestamp = the ABS progress `lastUpdate`, so the device sees a newer position and jumps to it.
3. No CFI (percent-only progress): place the percent across chapters by character count and pick the span there (BookBridge's fallback).
4. Status: `isFinished` → `Finished`; progress > 0 → `Reading`; else `ReadyToRead`.

---

## 8. Deleting and removing

| Event | Behavior |
|---|---|
| User deletes a book **on the Kobo** | `DELETE /v1/library/<id>` → mark `removed` for **that device only**, 204. Not hidden anywhere in ABS (ABS has no per-user archive). The book stays off that device until the user taps "Resync everything" or re-adds it in the device's settings. |
| Item leaves scope (library unselected, removed from synced collection, ebook deleted, item deleted, user loses access) | Next sync sends `ChangedEntitlement` with `IsRemoved: true`; row marked `removed`. This covers CW's open "removed from shelf stays on device" and "hard delete never propagates" bugs. |
| Collection deleted, or unflagged for the device | Tombstone → `DeletedTag`, tombstone removed after checkpoint confirmation. |
| Device deleted in ABS | Its rows cascade away. |

---

## 9. KEPUB conversion

CWA's approach (Lesson 23): never convert during sync; advertise KEPUB; convert on the download request.

- `KepubManager.getKepub(libraryItem)`: cache at `<MetadataPath>/cache/kepub/<itemId>-<ebook mtime>.kepub.epub`; run `kepubify <src> -o <tmp dir>` into a unique temp dir (CWA 7536a81: shared temp names served the wrong book), move into the cache; one conversion per item at a time (promise lock); 120 s timeout; on failure log and serve the epub.
- Served with `Content-Disposition` filename `*.kepub.epub` (Lesson 10).
- Binary: Docker downloads `kepubify-linux-64bit` / `-arm64` in the `build-server` stage like libnusqlite3, `ENV KEPUBIFY_PATH`; non-Docker installs get a `Binary('kepubify', ...)` in `BinaryManager` with `required = false` and its own `--version` check. Without kepubify, sync still works with plain EPUB (position sync is then chapter-level, Lesson 10).
- The cache is cleaned when the item is deleted or its ebook changes (mtime in the name makes old entries dead; a cron sweep removes them).

---

## 10. Store proxy and local-only mode

Exactly CW's rules (Lesson 25): GET → 307 to `https://storeapi.kobo.com/<path>`; other methods proxied server-side with headers copied minus `Host`, hop-by-hop headers and `content-encoding` stripped, 2 s / 10 s timeouts, failures fall back to `{}` (auth routes fall back to dummy tokens). `/v1/initialization` merges the store's resources and **always** overrides `library_sync`, `image_host`, `image_url_template`, `image_url_quality_template` (Lesson 8). `ExpiredToken` from the store's init is passed through (CWA).

With the proxy off (Kobo with no account, or user preference): native resource dict, dummy `/v1/auth/device|refresh`, `/v1/user/add-device`, `/oauth/*` + OIDC discovery stubs, and `oauth_host`/`reading_services_host` pointed at ABS (Lesson 14). The reading-services stubs live at the **site root** (`/api/v3/content/...`, `/api/UserStorage/...`), which collides with ABS's own `/api` router: they must be registered before `ApiRouter` and match only those exact Kobo paths. This mode ships last (phase 4).

---

## 11. Phases

Each phase ends with tests passing and a real-device check.

1. **Books on the device.** Models + migration, `KoboRouter` with token auth, init, auth stubs, catch-all, store proxy, sync of entitlements with checkpoint confirmation, metadata, covers, downloads (epub as-is), device UI (add/delete/resync), admin page.
2. **KEPUB.** kepubify bundling, on-demand conversion, `.kepub.epub` naming, `EPUB3FL`.
3. **Reading progress both ways** with exact positions (§7), `ChangedReadingState` in the stream.
4. **Collections** as Kobo collections, "only selected collections" mode, removals and tombstones; device-side collection edits applied when permitted (§12).
5. **Local-only mode** (no Kobo account): OAuth/OIDC and reading-services stubs.

---

## 12. Decisions (owner, 2026-11-14)

1. **Collections: two-way when permitted.** ABS collections sync to the device as Kobo collections. Edits made on the Kobo (create, rename, delete, add/remove books) are applied to the ABS collection when the user has the update permission (`canUpdate`; create needs it too, delete needs `canDelete`); otherwise they're answered with 200 and ignored, logged at info. Collections are per library in ABS, so a collection created on the Kobo lands in the library of its first book. A per-device "only sync selected collections" option mirrors CW's shelf mode.
2. **Deleting on the Kobo removes it from that device only** (§8). Nothing changes in ABS. It stays off that device until "Resync everything" or until it's re-added from the device settings.
3. **One token per device.** Delivery state is per device; reading progress is per user.
