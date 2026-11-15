# Kobo sync

A stock Kobo e-reader (no KOReader, one config line) syncs ebooks, reading progress and collections with Audiobookshelf the way it does with Calibre-Web (CW). The wire protocol is CW's `kobo.py`; where CW has a known bug, the fix (from Calibre-Web-Automated or an open upstream PR) is taken instead.

## Setup

1. Admin: **Settings → Kobo sync**. Enable Kobo sync, choose whether unknown requests are forwarded to the Kobo store (on by default), and optionally set a **public URL**. Kobos drop the port from the `Host` header, so every URL sent to a device uses the public URL when set, else the request host.
2. User (needs download permission): **Account → Kobo devices → Add device**. Pick a name and the libraries to sync (default: all the user can access), optionally "only sync selected collections". The setup line is shown once:

   ```
   api_endpoint=https://audiobooks.example.com/kobo/<token>
   ```

   Each device can be edited, resynced ("Resync everything"), given a new setup line, or deleted.
3. On the Kobo: replace the `api_endpoint` line in `.kobo/Kobo/Kobo eReader.conf`, eject, tap Sync.

## Code

| File | Role |
|---|---|
| `server/routers/KoboRouter.js` | Mounted at `/kobo/:token`; token → device → user; catch-all |
| `server/controllers/KoboController.js` | Device requests: init, auth stubs, sync, metadata, state, tags, delete, cover, download |
| `server/controllers/KoboDeviceController.js` | `/api/me/kobo-devices` CRUD, new token, resync |
| `server/managers/KoboSyncManager.js` | Sync pages, delivery state, checkpoints |
| `server/managers/KoboReadingStateManager.js` | Reading progress both ways |
| `server/managers/KoboCollectionManager.js` | Collection edits made on the device |
| `server/managers/KoboStoreProxy.js` | Forwarding to `storeapi.kobo.com` |
| `server/managers/KepubManager.js` | On-demand kepubify conversion and cache |
| `server/utils/kobo/` | Sync token, entitlement/metadata JSON, native resources, KoboSpan ↔ CFI mapping |
| `server/models/Kobo*.js` | Data, created by `sequelize.sync()` like `mediaItemShare` (no migration) |
| `client/pages/config/kobo.vue`, `client/components/modals/KoboDeviceModal.vue`, `client/pages/account.vue` | UI |

## Data model

- **`koboDevice`**: `userId`, `name`, `tokenHash` (sha256 of the 32 hex char URL token; the token itself is only shown once), `libraryIds` (null = all), `onlyCollections`, `collectionIds`, `lastSyncAt`.
- **`koboSyncedItem`**: per device and library item (not a foreign key, so a deleted item can still be removed from the device). Delivered state (`deliveredAt`, `deliveredVersion`, `deliveredFormat`, `isRemoved`, `removedBy = 'device'` when deleted on the Kobo) and pending state (`pendingCheckpoint`, `pendingVersion`, `pendingFormat`, `pendingRemoved`). Unique (`koboDeviceId`, `libraryItemId`).
- **`koboSyncedCollection`**: per device and collection, `deliveredHash` (sha1 of name + book list; adding a book does not touch a collection's `updatedAt`), `isDeleted`, and the same pending fields.
- **`koboReadingState`**: per user and item (progress belongs to the user). The device's raw `CurrentBookmark`, `StatusInfo`, `Statistics`, its `LastModified`/`PriorityTimestamp` strings, and `snapshot`: the ebook location, ebook progress and finished flag of the media progress this state stands for.

Delivery state is per device, so a second Kobo gets every book.

## Sync (`GET /v1/library/sync`)

- `x-kobo-synctoken` is base64 JSON `{ version: '1-1-0', data: { raw_kobo_store_token, checkpoint, reading_state_last_modified } }`, sent as a plain string. A token containing `.` is the store's own (first sync after switching): it is kept and the sync starts fresh. Anything unreadable starts fresh.
- **Scope**: items in the device's libraries the user can access, with an epub (a `.kepub.epub` file counts as one), limited to the selected collections in collection mode. Items marked missing (e.g. a share unmounted during a scan) are neither sent nor removed; the device keeps what it has until they return.
- **Pending**: in scope and never delivered, or newer than the delivered version, or now in a different format; plus **removals**: delivered, not removed, no longer in scope (library unselected, collection unflagged, ebook or item deleted, access lost). Items deleted on the Kobo stay off that device until "Resync everything".
- Pages of 100, ordered by change time, `x-kobo-sync: continue` while more remain. `NewEntitlement` if the device never confirmed the item, else `ChangedEntitlement`. A book whose JSON fails to build is logged and skipped.
- **Checkpoints**: every page gets a new checkpoint id; its rows are written as pending under it. Only when the device presents that checkpoint in its next sync token do they become delivered. CW marks books sent while building the response, which loses them when the device aborts a page; here an unconfirmed page is simply sent again.
- **Reading states**: `ChangedReadingState` for held books whose progress or stored Kobo state changed since the cursor (see below), at most 100 per page.
- **Collections**: `NewTag`/`ChangedTag` with the full book list, `DeletedTag` for delivered collections that are gone or out of scope. Not paginated (CW behavior).
- **Store merge** (forwarding on): on the last local page only, the store's own sync is fetched with the stored store token and appended; its new token is kept inside ours and `x-kobo-sync`, `x-kobo-sync-mode`, `x-kobo-recent-reads` are copied when present.
- Timestamps go out as `YYYY-MM-DDTHH:MM:SSZ`. Cover ids are `<itemId>-<version seconds>`, so a new cover reaches the device. Series ids are `uuid3(DNS, name)` like CW.

## Reading progress

ABS media progress (`ebookLocation` CFI, `ebookProgress`, `isFinished`) is the source of truth.

**Device → ABS** (`PUT /v1/library/<id>/state`): every key is optional. The raw state is stored, the bookmark is converted with `kepubPosition.js` (KoboSpan → exact fraction + CFI against the original epub; else chapter + in-chapter percent; else book percent; a KoboSpan bookmark converts the kepub on demand when it is not cached, since kepubify v4 output is deterministic) and applied with `user.createUpdateMediaProgressFromPayload`, followed by `user_updated` like `PATCH /api/me/progress`. The answer carries no server-stamped `LastModified` (CW PR #3607).

- `Finished` → `isFinished: true`. The Kobo **never** sends `isFinished: false`: unfinishing an ABS item resets the audiobook position to 0, so a book reopened on the Kobo stays finished in ABS.
- The stored row gets the snapshot of the resulting media progress.

**ABS → device** (`GET .../state`, entitlements, `ChangedReadingState`):

- While the current media progress snapshot equals the stored one, the stored Kobo state is returned verbatim (same numbers and timestamps). Anything else makes the Kobo ask "Return to last page read?".
- When it differs (the web reader, an app or BookBridge moved the ebook position), a bookmark is built: CFI → character → the KoboSpan at or before it, with integer `ProgressPercent` and `ContentSourceProgressPercent`; `LastModified` is the progress's `updatedAt`. It is stored as the new Kobo state with the new snapshot, so later calls return it verbatim.
- Audio playback changes `mediaProgress.updatedAt` constantly but not the snapshot, so it never resends a state. A candidate whose snapshot matches and whose stored row is not newer than the cursor is skipped.
- Cursor: candidates are progress rows and stored states with `updatedAt >= cursor`. While more remain than fit, the cursor is the last processed item's time (ties at that time are picked up next page; the ones already sent are skipped by the snapshot rule). Only when nothing remains does it move past everything, including states sent inside entitlements.
- After a kepub download, a stored state without a KoboSpan is rebuilt on the next sync so the device gets an exact position.

## KEPUB

Never converted during sync (only on download, or for a KoboSpan bookmark from the device). When kepubify is available (or the file already is a `.kepub.epub`), the entitlement offers one `KEPUB` download; otherwise `EPUB3` + `EPUB`. Fixed-layout epubs (`rendition:layout` `pre-paginated`) are offered as `EPUB3FL`.

- On download, `KepubManager` runs `kepubify <src> -o <unique temp dir> -i` (120 s timeout, one conversion per cache file at a time) and moves the result to `<metadata>/cache/kepub/<itemId>-<ebook mtime>.kepub.epub`, removing that item's older conversions. On failure the epub is served. The file is served as `<title>.kepub.epub`, which the Kobo uses to pick its kepub renderer.
- The Docker image bundles kepubify **v4.0.4** and sets `KEPUBIFY_PATH`. Other installs set `KEPUBIFY_PATH` to a kepubify binary themselves; without it sync works with plain EPUB (reading positions are then chapter-level on the device).
- Pinned to v4.0.4, not v5: kepubify v5 (2026-11-08) says its output, including koboSpan numbering, may differ from v4. A Kobo's bookmarks name koboSpans in the file it downloaded, so the server must convert the same way. Moving to v5 means clearing the kepub cache and re-sending books.

## Store forwarding

With forwarding on: unknown GETs get a 307 to `https://storeapi.kobo.com/<path>`; other methods are proxied server side (a Kobo turns a redirected POST into a GET) with hop-by-hop headers stripped and a 10 s timeout; a store failure falls back to `{}` (dummy tokens for auth routes). `/v1/initialization` merges the store's resources but always points `library_sync` and the image templates at ABS, and passes the store's `ExpiredToken` through. Unknown covers redirect to Kobo's CDN.

With forwarding off (a Kobo without an account): native resources, dummy auth, OAuth/OIDC stubs under `/kobo/<token>/oauth`, and the reading-services stubs (`/api/v3/content/...`, `/api/UserStorage/...`) answered at the site root ahead of the `/api` router.

Unknown endpoints never 404 (a 404 can abort the device's sync queue). Failed token lookups are rate limited with the auth limits (`RATE_LIMIT_AUTH_*`); successful device requests, and store 401s relayed for a valid device, do not count.

## Owner decisions

1. **Collections are two-way.** Kobo collection edits (create, rename, delete, add/remove books) are applied to the ABS collection when the user may update (delete needs delete permission); otherwise they are answered and ignored. A collection created on the Kobo lands in the library of its first book.
2. **Deleting on the Kobo removes the book from that device only.** Nothing changes in ABS.
3. **One token per device.** Delivery state is per device; reading progress is per user.
4. **Exact positions.** KoboSpan ↔ CFI mapping is character exact, not percentage based.
5. **Never unfinish from the Kobo** (see Reading progress).
