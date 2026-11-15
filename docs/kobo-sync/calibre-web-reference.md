# Calibre-Web Kobo Sync: Behavioral Reference

This is a clean-room behavioral spec of Calibre-Web's (CW) Kobo sync, written as the reference for reimplementing it in Audiobookshelf. It also covers the fixes that Calibre-Web-Automated (CWA) added.

Sources (read-only):

- Upstream `janeczku/calibre-web` at `6e840acb` (2026-09-20). Files: `cps/kobo.py`, `cps/kobo_auth.py`, `cps/kobo_sync_status.py`, `cps/services/SyncToken.py`, `cps/ub.py`, `cps/helper.py`, `cps/tasks/convert.py`, `cps/epub.py`, `cps/shelf.py`, `cps/editbooks.py`, `cps/admin.py`, `cps/web.py`, `cps/reverseproxy.py`, `cps/main.py`.
- CWA at `4fc2c44` (2026-10-01; shallow, 200 commits) plus its `changelogs/V4/*`.
- GitHub issues and PRs from `janeczku/calibre-web`, found with the public search API.

How to read this:

- "CW" means upstream behavior and "CWA" means the fork.
- Commit hashes are upstream unless marked CWA.
- `#NNNN` is an upstream issue or PR unless marked "CWA #NNNN".
- Each item is marked as either code behavior, which was verified in the source, or an inference, which is labeled as one.

---

## 0. Mental model (read this first)

1. **The device is pointed at CW by one config line.** In `.kobo/Kobo/Kobo eReader.conf` under `[OneStoreServices]`, the user sets `api_endpoint=https://host/kobo/<auth_token>`. The device then calls `<api_endpoint>/v1/...` for everything, including `/v1/initialization`, auth, sync, state, tags and store browsing. CW answers the library endpoints locally. Everything else is redirected or proxied to `https://storeapi.kobo.com`, or stubbed with `{}`.
2. **Sync is pull-based and paginated.** The device calls `GET /v1/library/sync` with an `x-kobo-synctoken` header. CW returns a JSON array of change events and a new `x-kobo-synctoken`. If more pages remain, it also returns `x-kobo-sync: continue`, and the device immediately calls again.
3. **Which books are sent is decided by a server-side table (`kobo_synced_books`), not by timestamps.** In "all books" mode, a book is sent if it has a Kobo-compatible format and is *not* in `kobo_synced_books` for this user. Once a book is emitted, it is inserted into that table. To make a book "change" (re-send it), CW *deletes* its row from that table. The deletion happens on edits, format changes, conversions and archive toggles. The SyncToken timestamps mostly decide New vs. Changed, and drive reading-state and shelf deltas.
4. **Deleting a book on the device archives it in CW.** "Archived" is per-user state (`archived_book`). Archived books are still synced, but with `IsRemoved: true`, which removes them from the device. Archiving in the web UI therefore removes the book from the Kobo. Archived books are also hidden from that user's web UI.
5. **Shelves map to Kobo "collections" (Tags).** Optionally, only books on shelves flagged `kobo_sync` are synced ("only sync selected shelves" mode).
6. **Reading progress is per user, per book.** It is stored in `kobo_reading_state`, plus `kobo_bookmark`, `kobo_statistics` and `book_read_link` (`ReadBook`). The device pushes progress with `PUT /v1/library/<uuid>/state`, and it is pushed back to devices inside the sync stream.
7. **All state is keyed by *user*, never by *device*.** This is the root cause of several bugs. See Lessons 1 and 26.

---

## 1. Endpoint inventory

All routes live under the blueprint prefix `/kobo/<auth_token>`. A URL value preprocessor pops `auth_token` into `g.auth_token`. `@requires_kobo_auth` resolves the token to a user (see §2). Failed auth returns **401** with no login redirect, because `lm.blueprint_login_views["kobo"] = None`.

Legend: **L** = answered locally. **P** = proxied or redirected to the Kobo store when `config_kobo_proxy` is on. **S** = stub when the proxy is off.

| Method | Path (after `/kobo/<token>`) | Auth | Handling | Response |
|---|---|---|---|---|
| GET | `` (empty, i.e. `/kobo/<token>`) | none | L | `{}` 200. This is the `api_endpoint` root. |
| GET | `/v1/initialization` | kobo | L (+P to fetch store resources) | `{"Resources": {...}}`, header `x-kobo-apitoken: e30=` |
| POST | `/v1/auth/device` | kobo | P (POST is proxied) or S | Dummy token JSON (see §2) |
| POST | `/v1/auth/refresh` | kobo | same as `/v1/auth/device` | Added in 2700b4f0 (#3492): firmware 4.38 (Nov 2025) started calling it, and the 404 broke sync. |
| GET | `/v1/library/sync` | kobo, plus the *download* role (403 otherwise) | L, plus a merge of store results if the proxy is on | JSON array; `x-kobo-synctoken`, optional `x-kobo-sync: continue` |
| GET | `/v1/library/<book_uuid>/metadata` | kobo + `download_required` | L; if the book is unknown or has no data, P/S | `[ <BookMetadata> ]`, `Content-Type: application/json; charset=utf-8`, `ensure_ascii=False` |
| GET | `/v1/library/<book_uuid>/state` | kobo | L; if the book is unknown, P/S | `[ <ReadingState> ]` (via `jsonify`) |
| PUT | `/v1/library/<book_uuid>/state` | kobo | L; if the book is unknown, P/S | `{"RequestResult":"Success","UpdateResults":[...]}` |
| DELETE | `/v1/library/<book_uuid>` | kobo | L (archive the book); if the book is unknown, P/S | `""` **204** |
| POST | `/v1/library/tags` | kobo | L | 201, body = JSON string of the shelf uuid (`"\"<uuid>\""`) |
| DELETE | `/v1/library/tags` | kobo | L | **405**. This is caught deliberately so it doesn't fall into the `<dummy>` DELETE handler. |
| PUT | `/v1/library/tags/<tag_id>` | kobo | L (rename); if the shelf is unknown: P when the proxy is on, else 404 | `' '` 200 |
| DELETE | `/v1/library/tags/<tag_id>` | kobo | L (delete the shelf); if unknown: P or 404 | `' '` 200, or 401 if the delete fails |
| POST | `/v1/library/tags/<tag_id>/items` | kobo | L | `''` 201; 404 for an unknown shelf; 401 without edit permission |
| POST | `/v1/library/tags/<tag_id>/items/delete` | kobo | L | `''` 200 |
| GET | `/<book_uuid>/<w>/<h>/<isGreyscale>/image.jpg` | kobo | L; for an unknown cover: 307 to the Kobo CDN when the proxy is on, else 404 | JPEG |
| GET | `/<book_uuid>/<w>/<h>/<Quality>/<isGreyscale>/image.jpg` | kobo | same | JPEG |
| GET | `/download/<book_id>/<book_format>` | kobo + `download_required` | L | File; for `kepub`, `Content-Disposition` filename ends `.kepub.epub` |
| DELETE/GET/POST | `/v1/library/<dummy>` | none | P/S | |
| POST | `/v1/library/<dummy>/preview` | none | P/S (OverDrive returns, 0eb8583d / #3398) | |
| GET/POST | `/v1/user/loyalty/<dummy>`, `/v1/user/profile`, `/v1/user/wishlist`, `/v1/user/recommendations`, `/v1/analytics/<dummy>`; GET `/v1/assets` | none | P/S | `{}` |
| GET | `/v1/user/loyalty/benefits` | none | P, or S = `{"Benefits": {}}` | |
| GET/POST | `/v1/analytics/gettests` | none | P, or S = `{"Result":"Success","TestKey":<X-Kobo-userkey header or "">,"Tests":{}}` | |
| GET/POST | `/v1/products/...` (many explicit routes plus the catch-all `/v1/products/<path:dummy>` and its `/` variant), `/v1/affiliate`, `/v1/deals` | none | P/S | |

Notes:

- When the proxy is off, the "Stub" response for every unimplemented route is `make_response(jsonify({}))`: HTTP 200 with body `{}`. The device tolerates this for store and user endpoints. **The stubs exist mainly to avoid 404s**, because certain 404s make the device abort the whole sync queue. See Lessons 13 and 27.
- Rate limiting: `main.py` applies `limiter.limit("3/minute", key_func=get_remote_address)` to the entire kobo blueprint. Every successful `requires_kobo_auth` call, and every unauthenticated stub route, **clears** the limiter keys. So in practice only requests with bad tokens are throttled, which acts as brute-force protection on the token. CWA instead calls `limiter.check()` and returns **429**.
- CSRF is exempted on all mutating Kobo routes (`@csrf.exempt`).
- CWA adds these routes (§10):
  - `POST /v1/user/add-device`
  - `/oauth/token`, `/oauth/refresh` and `/oauth/<path>`
  - `GET /oauth/.well-known/openid-configuration`
  - `/v1/categories/<dummy>[/featured|/products]` and `/v1/products/featuredforkoboplus/`
  - an app-wide `before_app_request` stub for `/api/v3/content/checkforchanges`, `/api/v3/content/*/annotations`, `/api/UserStorage/*` and `/api/internal/notebooks*`. These are served at the **site root**, not under `/kobo/<token>`.

### Headers

| Header | Direction | Meaning |
|---|---|---|
| `x-kobo-synctoken` | request and response | The SyncToken (§3.1). The device echoes back whatever it last received. |
| `x-kobo-sync` | response | `continue` means another page is pending and the device calls sync again immediately. When the proxy is on, on the final page this is copied from the store response. |
| `x-kobo-sync-mode`, `x-kobo-recent-reads` | response | Copied from the store's sync response when the proxy is on. Never generated locally. |
| `x-kobo-apitoken` | response on `/v1/initialization` | Always `e30=` (base64 of `{}`). |
| `X-Kobo-userkey` | request | The device's Kobo store user key. Only used to echo `TestKey` in gettests. CW ignores it for auth. |
| `Host` | request | Stripped before proxying. Note: the device may send a Host header **without the port** (see §2.4). |

---

## 2. Auth

### 2.1 Token model

- Table `remote_auth_token`. Columns:
  - `auth_token` (unique string)
  - `user_id`
  - `token_type` (`1` = Kobo)
  - `expiration` (`datetime.max` for Kobo)
  - `verified`
  - `request_ip`
  - `request_user_agent`
- There is **one Kobo token per user**. It is generated lazily by `GET /kobo_auth/generate_auth_token/<user_id>` as `hexlify(urandom(16))`, which is 32 lowercase hex characters. The route returns an HTML fragment showing:

  ```
  api_endpoint=<url_for("kobo.TopLevelEndpoint", auth_token=token, _external=True)>
  ```

  If the page was opened via `localhost`, `127.*`, `[::1]` or `[::ffff:7f..]`, it shows a warning instead, because the generated URL would be unusable from the device (d0e603e6, 3b216bfa / #1990).
- `POST /kobo_auth/deleteauthtoken/<user_id>` deletes the token.
- Both `/kobo_auth` routes require the caller to be that user or an admin. This was an IDOR fix: d5980541 (2026-04) upstream, CWA 4875df6 / CWA #1303.
- `requires_kobo_auth`:

  ```python
  user = ub.session.query(ub.User).join(ub.RemoteAuthToken)
         .filter(ub.RemoteAuthToken.auth_token == auth_token)
         .filter(ub.RemoteAuthToken.token_type==1).first()
  if user: login_user(user); <clear rate limits>; return f()
  abort(401)
  ```

  `login_user` also sets a session cookie. Historically, that cookie was used to authorize downloads (2b55b9b2). Today the download URL itself carries the token (ae33aee3, c279055a / #1908), so the cookie isn't needed.

### 2.2 History of the auth design (why the token is in the URL)

- At first, CW authenticated with the Kobo store `x-kobo-userkey` header, storing only its hash (9ede01f1). That was abandoned in 27d084ce.
- The reasons, from the `kobo_auth.py` docstring:
  - the UserKey is an irrevocable credential that is valid for the real Kobo store
  - some device requests (book downloads) carry no auth headers at all
- The current design puts a random CW-generated token in the path, so **every** request, including downloads and covers, is authenticated by its URL.

### 2.3 `/v1/auth/device` and `/v1/auth/refresh`

```python
def make_calibre_web_auth_response():
    content = request.get_json()           # CWA: get_json(silent=True) or {}
    return jsonify({
        "AccessToken":  b64(urandom(24)),
        "RefreshToken": b64(urandom(24)),
        "TokenType": "Bearer",
        "TrackingId": str(uuid4()),
        "UserKey": content.get('UserKey', ""),   # a1899bf5 / #2603: devices with no Kobo account send no UserKey
    })
```

- With the proxy on, the POST is forwarded to the store (§7). On any exception, CW falls back to the dummy response above (`redirect_or_proxy_request(auth=True)`, 46f111cd / #3334).
- CW never validates these bearer tokens.
- In upstream, `request.get_json()` throws on an empty or non-JSON body. CWA made the call `silent=True`, because `add-device` and `refresh` can arrive without a body.

### 2.4 `/v1/initialization`

1. If the proxy is on, CW forwards the request to the store. If the JSON has `Resources`, those are used. On failure, or when the proxy is off, CW uses `NATIVE_KOBO_RESOURCES()`. That is a hard-coded dict of about 150 store URLs and feature flags (see `kobo.py` lines 1163-1320). It can be overridden by a JSON file `kobo_resources.txt` in `BASE_DIR` (36ef81dd / #3472).
2. CW always overrides these four keys:
   - `image_host`
   - `image_url_quality_template`
   - `image_url_template`
   - `library_sync`. This one was added only in 2026-02, in a9713bd4: without it, firmware that honors `library_sync` from the store's resources called Kobo's servers for sync and got no books when the proxy was on.
3. URL construction:
   - **Not "proxied"** (no `X-Script-Name` or `X-Forwarded-Host` header): the base is `"{scheme}://{host_without_port}:{config_external_port}"`. CW strips the port from `request.host`, unless the host ends in `]` (IPv6), and appends the *configured external port*. The reason: "kobo reader generating requests without right port number, causing url_for not working correct" (0411d4a8). Lesson 7.
   - **Proxied**: the base comes from `url_for(..., _external=True)`, using `X-Forwarded-Host`, `X-Scheme` and `X-Script-Name`.
4. Templates produced (note the casing and placeholders, which work in practice):

   ```
   image_host                  = <base>                      (proxied: url_for("web.index", _external=True).strip("/"))
   image_url_quality_template  = <base>/kobo/<token>/{ImageId}/{width}/{height}/{Quality}/isGreyscale/image.jpg
   image_url_template          = <base>/kobo/<token>/{ImageId}/{width}/{height}/false/image.jpg
   library_sync                = <base>/kobo/<token>/v1/library/sync
   ```

   `unquote()` is applied so the braces survive `url_for`. The Kobo-native templates use `{Width}/{Height}/{IsGreyscale}`. CW's lowercase `{width}`/`{height}` and literal `isGreyscale` evidently still work: the route accepts any segment, and `height` is parsed defensively (Lesson 18). **For ABS (inference): prefer the native-cased placeholders `{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}`, and still parse leniently.**
5. Response: `{"Resources": kobo_resources}` with header `x-kobo-apitoken: e30=`.
6. CWA additions:
   - If the store's init response has `ResponseStatus.ErrorCode == "ExpiredToken"`, CWA returns the store response verbatim, which triggers the device to re-authenticate.
   - When the proxy is off, CWA rewrites `oauth_host` to `<base>/kobo/<token>/oauth` and `reading_services_host` to the CW root (§10).
   - The upstream Instapaper keys (9e7efb18) exist because newer firmware writes empty values when they're missing.

### 2.5 Device-side config (outside CW)

Users edit `.kobo/Kobo/Kobo eReader.conf`:

```
[OneStoreServices]
api_endpoint=https://host/kobo/<token>
```

Some guides also set `image_host` and `image_url_*`, but `/v1/initialization` overrides them anyway. Changing `api_endpoint` to anything with a path suffix breaks sync: #3364 has a user who appended `/v1/library/sync`.

---

## 3. Sync algorithm (`GET /v1/library/sync`)

### 3.1 SyncToken

The token is base64(JSON); padding is tolerated on read. Header name: `x-kobo-synctoken`.

```json
{ "version": "1-1-0",
  "data": {
    "raw_kobo_store_token": "<opaque store token or ''>",
    "books_last_modified":        <epoch float seconds>,
    "books_last_created":         <epoch float>,
    "archive_last_modified":      <epoch float>,
    "reading_state_last_modified":<epoch float>,
    "tags_last_modified":         <epoch float> } }
```

- `VERSION = "1-1-0"` and `MIN_VERSION = "1-0-0"`. Versions are compared as **strings** (`"1-1-0" < "1-0-0"`).
- Epoch: `(dt - datetime(1970,1,1)).total_seconds()` on naive UTC datetimes. `datetime.min` becomes a huge negative number. On read, `utcfromtimestamp` failures (`OSError` on Windows, `OverflowError` on Linux) map back to `datetime.min` (c1f5252b / #1509, 12263ff0 / #1423).
- Parsing (`from_headers`):
  - An empty header gives a fresh token, with all fields at `datetime.min`.
  - **A header containing `.` is a raw Kobo store token.** That's a JWT-like `blob.blob`, received on the first sync after switching from the real store. CW stores it in `raw_kobo_store_token` and treats everything else as fresh.
  - Otherwise CW base64-decodes, JSON-parses and schema-validates the header. On a `ValidationError` or `ValueError` it logs "Sync token contents do not follow the expected json schema" and returns a fresh token.
  - Bug: the second `validate()` call validates the outer object, not `data`, so the data schema is effectively unchecked. Also, the data schema says `"type":"string"` for fields that are actually numbers.
- The token is written with `b64encode(json.dumps(token).encode()).decode("utf-8")`. Before b1d7bade, the `.decode()` was missing and the header became `b'...'`. The device sent that back, it failed to parse, and every sync looked like a first sync, looping forever and draining the battery (#3017).
- `books_last_id` existed briefly (c25afdc2 to 5edde53f, 2020-12 to 2021-10) for keyset pagination. It was removed when `kobo_synced_books` was introduced. Open PR #3584 proposes reintroducing it as version `1-2-0`.

### 3.2 Step by step

```
1. if user lacks download role → 403.
2. token = SyncToken.from_headers()
3. If kobo_synced_books has NO rows for this user:      # 25422b34 / #2195 — makes "force full sync" real
       token.books_last_modified = token.books_last_created = token.reading_state_last_modified = datetime.min
   (tags_last_modified and archive_last_modified are NOT reset.)
4. new_books_last_modified = token.books_last_modified
   new_books_last_created  = token.books_last_created
   new_reading_state_last_modified = token.reading_state_last_modified
   new_archived_last_modified = datetime.min
5. calibre_db.reconnect_db()     # fresh view of metadata.db (external Calibre edits)
6. Build changed_entries query (mode-dependent, below).
7. For each row in changed_entries.limit(SYNC_ITEM_LIMIT=100):
     a. if no KEPUB, has EPUB, kepubify configured → enqueue background EPUB→KEPUB conversion (non-blocking)
     b. rs = get_or_create_reading_state(book)          # creates ReadBook + KoboReadingState rows if absent (side effect!)
     c. entitlement = {"BookEntitlement": create_book_entitlement(book, archived=is_archived==True),
                       "BookMetadata":    get_metadata(book)}
     d. if rs.last_modified > token.reading_state_last_modified:
            entitlement["ReadingState"] = reading_state_response(...)
            new_reading_state_last_modified = max(..., rs.last_modified)
            remember book id in reading_states_in_new_entitlements
     e. ts_created = max(book.timestamp (tz stripped), BookShelf.date_added if shelf mode)
        if ts_created > token.books_last_created → {"NewEntitlement": entitlement}
        else                                     → {"ChangedEntitlement": entitlement}
     f. new_books_last_modified = max(new_books_last_modified, book.last_modified, date_added if shelf mode)
        new_books_last_created  = max(new_books_last_created, ts_created)
     g. kobo_sync_status.add_synced_books(book.id)       # INSERT into kobo_synced_books (idempotent)
8. new_archived_last_modified = max ArchivedBook.last_modified among archived rows of the query (informational only).
9. book_count = changed_entries.count()   # re-evaluated AFTER step 7 inserted rows → "remaining"
   cont_sync = bool(book_count)
10. Reading states (see 3.5); cont_sync |= (count > 100)
11. sync_shelves(token, results, only_kobo_shelves)       # §3.6
12. if not cont_sync: token.books_last_created = new_books_last_created   # only advance after the final page
    token.books_last_modified = new_books_last_modified
    token.archive_last_modified = new_archived_last_modified
    token.reading_state_last_modified = new_reading_state_last_modified
13. generate_sync_response(token, results, cont_sync)     # §3.7
```

`SYNC_ITEM_LIMIT = 100` was `5` in the first chunked version (c25afdc2) and became 100 in ca212c87. Before chunking, large libraries timed out: #1276 reports a device giving up around 286 KB.

### 3.3 `changed_entries`, "all books" mode (`user.kobo_only_shelves_sync == 0`)

```python
query(db.Books, ArchivedBook.last_modified, ArchivedBook.is_archived)
  .join(db.Data)                                                  # one row PER FORMAT
  .outerjoin(ArchivedBook, and_(Books.id == ArchivedBook.book_id, ArchivedBook.user_id == me))
  .filter(Books.id.notin_(select book_id from kobo_synced_books where user_id == me))
  .filter(common_filters(allow_show_archived=True))               # user's tag/language/custom-column restrictions (c6dadbe7/#1938)
  .filter(Data.format.in_(KOBO_FORMATS))                          # KEPUB, EPUB  (dict keys)
  .order_by(Books.last_modified).order_by(Books.id)
```

- **No timestamp filter at all.** Membership in `kobo_synced_books` is the cursor. The design came from 5edde53f (2021-10, "Improved sync for kobo with additional table"). Before that, the cursor was `Books.last_modified > token.books_last_modified`, which skipped books and repeated others, and caused the pagination bugs in Lessons 2-5.
- Archived books *are* included, and they are emitted with `IsRemoved: true`.
- Quirk (inference from the query shape): a book with both EPUB and KEPUB yields two rows, because there's no `.distinct()` in this mode. It could be emitted twice in one page. `add_synced_books` is idempotent, so state isn't corrupted.

### 3.4 `changed_entries`, "only sync selected shelves" mode

```python
query(db.Books, ArchivedBook.last_modified, BookShelf.date_added, ArchivedBook.is_archived)
  .join(Data).outerjoin(ArchivedBook, <per-user>)
  .filter(Books.id.notin_(kobo_synced_books for me))
  .filter(BookShelf.date_added > token.books_last_modified)       # ← timestamp cursor mixed with table cursor
  .filter(Data.format.in_(KOBO_FORMATS))
  .filter(common_filters(allow_show_archived=True))
  .order_by(Books.id).order_by(ArchivedBook.last_modified)
  .join(BookShelf, Books.id == BookShelf.book_id).join(Shelf)
  .filter(Shelf.user_id == me)                                    # a56e071a / #2043 multi-user
  .filter(Shelf.kobo_sync).distinct()
```

- `ts_created = max(book.timestamp, BookShelf.date_added)`. So adding an old book to a synced shelf makes it a **NewEntitlement**, and it gets ordered by its date added to the shelf (6014b04b).
- **Known open bug (#3218, #3352, #3584).** `books_last_modified` advances to the max of `Books.last_modified` and `date_added` across the batch. But the batch is ordered by `Books.id`, and the next page filters `date_added > books_last_modified`. Unsent books whose `date_added` is older than some sent book's `last_modified`/`date_added` are therefore **permanently skipped**: only about 250 of 1,500 books reach the device. A "force full sync" resets the timestamps, but the same truncation repeats. See Lesson 2.

### 3.5 Reading states in the sync stream

```python
q = ub.session.query(KoboReadingState)
if shelf mode:
    q = q.join(BookShelf, KoboReadingState.book_id == BookShelf.book_id).join(Shelf)
         .filter(Shelf.user_id == me, Shelf.kobo_sync,
                 or_(KoboReadingState.last_modified > token.reading_state_last_modified,
                     func.datetime(BookShelf.date_added) > token.books_last_modified)).distinct()
else:
    q = q.filter(KoboReadingState.last_modified > token.reading_state_last_modified)
q = q.filter(KoboReadingState.user_id == me,
             KoboReadingState.book_id.notin_(reading_states_in_new_entitlements))
     .order_by(KoboReadingState.last_modified)                     # 0feb62c1
cont_sync |= q.count() > 100
for rs in q.limit(100): if book exists → {"ChangedReadingState": {"ReadingState": <ReadingState>}}
```

- A reading state that already rode along inside an entitlement on this page is not repeated.
- `new_reading_state_last_modified` is the max over both sources. Edge case (inference): if more than 100 states are pending and a new-entitlement state has a later `last_modified` than the 100th, the remaining states between them are skipped.
- Upstream `get_or_create_reading_state` (step 7b) creates a row with `last_modified=now` for every newly synced book. So nearly every `NewEntitlement` carries a `ReadingState`, and the reading-state cursor jumps to "now". CWA removed this and outer-joins the existing state instead (CWA 8467b51). That saved about 11 s on a 5,000-book first sync.

### 3.6 Shelves to Tags (`sync_shelves`)

```python
new_tags_last_modified = token.tags_last_modified
# 1) Deleted shelves: ALL ShelfArchive rows of this user, regardless of timestamp (df670795), each emitted then DELETED immediately
for s in ShelfArchive where user_id == me:
    results.append({"DeletedTag": {"Tag": {"Id": s.uuid, "LastModified": ts(s.last_modified)}}})
    delete s; commit
# 2) shelf mode: shelves with kobo_sync off modified since token → DeletedTag
#    upstream filter is `not ub.Shelf.kobo_sync`  → Python `not` on a column ⇒ False ⇒ NEVER matches (bug; fixed in CWA 0d4f800 as `== False`)
# 3) Changed/new shelves
for shelf in Shelf.outerjoin(BookShelf).filter(
        or_(func.datetime(Shelf.last_modified) > token.tags_last_modified,
            func.datetime(BookShelf.date_added) > token.tags_last_modified),
        Shelf.user_id == me, [Shelf.kobo_sync if shelf mode]).distinct().order_by(func.datetime(Shelf.last_modified)):
    if not view permission: continue
    new_tags_last_modified = max(new_tags_last_modified, shelf.last_modified)
    tag = create_kobo_tag(shelf)
    results.append({"NewTag": tag} if shelf.created > token.tags_last_modified else {"ChangedTag": tag})
token.tags_last_modified = new_tags_last_modified
```

Tag object:

```json
{"Tag": {"Created": "...Z", "Id": "<shelf.uuid>", "Items": [{"RevisionId": "<book uuid>", "Type": "ProductRevisionTagItem"}],
         "LastModified": "...Z", "Name": "<shelf name>", "Type": "UserTag"}}
```

- `Items` always holds the **full** membership list, so a `ChangedTag` replaces the collection contents.
- Books missing from the Calibre DB are skipped. Note that items are not filtered by "is this book synced/allowed".
- `Shelf.last_modified` is bumped by a SQLAlchemy `before_flush` hook whenever a `BookShelf` row is added or deleted. That's how membership changes reach the device.
- Public shelves owned by other users are not synced.
- Tags are **not paginated**: every changed shelf goes into the response, regardless of the page.

### 3.7 Response generation and store merge

```python
extra = {}
if config_kobo_proxy and not cont_sync:          # f22e4d99: only on the LAST local page
    store = make_request_to_kobo_store(token)     # request headers copied; x-kobo-synctoken := token.raw_kobo_store_token
    results += store.json()
    token.raw_kobo_store_token = store.headers.get("x-kobo-synctoken", "")
    extra["x-kobo-sync"]         = store.headers.get("x-kobo-sync")
    extra["x-kobo-sync-mode"]    = store.headers.get("x-kobo-sync-mode")
    extra["x-kobo-recent-reads"] = store.headers.get("x-kobo-recent-reads")
    (exceptions logged and ignored)
if cont_sync: extra["x-kobo-sync"] = "continue"
extra["x-kobo-synctoken"] = token.build_sync_token()
body = json.dumps(results)                        # NOT jsonify (7640ac1b: "jsonify decodes the unicode string different to what kobo expects")
Content-Type: application/json; charset=utf-8
```

- An empty result is `[]` with status 200.
- If the store says `continue`, the device calls again. CW re-runs its local query, finds nothing new, and fetches the store's next page.
- The SyncToken must be emitted even when the proxy is off. Before ad564e25 it wasn't, so every sync was a full sync.

### 3.8 Entitlement kinds emitted

| Kind | Emitted? | Shape |
|---|---|---|
| `NewEntitlement` | yes | `{"NewEntitlement": {"BookEntitlement", "BookMetadata", ["ReadingState"]}}` |
| `ChangedEntitlement` | yes (re-send, or removal via `IsRemoved: true`) | same |
| `ChangedReadingState` | yes | `{"ChangedReadingState": {"ReadingState": {...}}}` |
| `NewTag` / `ChangedTag` / `DeletedTag` | yes | above |
| `ChangedProductMetadata` | **never** in upstream. PR #3381 proposes it for metadata and cover updates. | — |

---

## 4. Reading state

### 4.1 Models (`app.db`)

- `kobo_reading_state`: `id`, `user_id`, `book_id`, `last_modified`, `priority_timestamp`. Both timestamps have `default=now(utc)` and `onupdate=now(utc)`.
- `kobo_bookmark`: `kobo_reading_state_id`, `last_modified`, `location_source`, `location_type`, `location_value`, `progress_percent` (Float), `content_source_progress_percent` (Float).
- `kobo_statistics`: `kobo_reading_state_id`, `last_modified`, `remaining_time_minutes` (Integer), `spent_reading_minutes` (Integer).
- `book_read_link` (`ReadBook`): `user_id`, `book_id`, `read_status` (0=UNREAD, 1=FINISHED, 2=IN_PROGRESS), `last_modified`, `last_time_started_reading`, `times_started_reading`. It links to `KoboReadingState` on (`user_id`, `book_id`).
- A `before_flush` hook sets `kobo_reading_state.last_modified = now` whenever a `ReadBook`, `KoboBookmark` or `KoboStatistics` row is new or dirty. That's how web-UI read toggles reach the device: `edit_book_read_status` also creates the Kobo state rows.

### 4.2 `GET /v1/library/<uuid>/state`

Returns `[ ReadingState ]`. It creates the rows if they're missing.

```json
{ "EntitlementId": "<uuid>",
  "Created": ts(book.timestamp),
  "LastModified": ts(rs.last_modified),
  "PriorityTimestamp": ts(rs.priority_timestamp),        // comment: "AFAICT PriorityTimestamp is always equal to LastModified"
  "StatusInfo": { "LastModified": ts(read.last_modified),
                  "Status": "ReadyToRead" | "Reading" | "Finished",
                  "TimesStartedReading": n,
                  "LastTimeStartedReading": ts }          // only if set
  "Statistics": { "LastModified": ts, "SpentReadingMinutes": n?, "RemainingTimeMinutes": n? },   // keys only if truthy
  "CurrentBookmark": { "LastModified": ts,
                       "ProgressPercent": n?,              // if not None; whole floats sent as int (d229f711)
                       "ContentSourceProgressPercent": n?, // same
                       "Location": {"Value": v, "Type": t, "Source": s} } }   // only if location_value truthy
```

Status mapping, both directions:

- `None` / `UNREAD(0)` ↔ `"ReadyToRead"`
- `FINISHED(1)` ↔ `"Finished"`
- `IN_PROGRESS(2)` ↔ `"Reading"`

An unknown status string raises `KeyError`, which becomes a 400.

### 4.3 `PUT /v1/library/<uuid>/state`

Request body: `{"ReadingStates": [ {<same shape as above>} ]}`. Only element `[0]` is used.

- `CurrentBookmark` (if truthy):
  - stores `ProgressPercent` and `ContentSourceProgressPercent`
  - if `Location` is truthy, stores its `Value`, `Type` and `Source`
  - Upstream indexes `["Location"]`, so a **missing key gives a 400**. CWA uses `.get` (CWA #1213).
  - Inference: `Type` is typically `KoboSpan` and `Value` a `kobo.N.M` span id.
- `Statistics` (if truthy): stores `int(SpentReadingMinutes)` and `int(RemainingTimeMinutes)`.
- `StatusInfo` (if truthy): maps `Status`. A transition *into* `Reading` from another status increments `times_started_reading` and sets `last_time_started_reading = now`.
- Upstream accesses `["CurrentBookmark"]`, `["Statistics"]` and `["StatusInfo"]` with `[]`, so all three keys must be present (values may be null).
- Any of `KeyError`, `TypeError`, `ValueError` or `StatementError` triggers a rollback and a **400**.
- Response:

  ```json
  {"RequestResult":"Success","UpdateResults":[{"EntitlementId":uuid,
    "CurrentBookmarkResult":{"Result":"Success"}, "StatisticsResult":{...}, "StatusInfoResult":{...},
    "LastModified": ts(rs.last_modified), "PriorityTimestamp": ts(rs.priority_timestamp)}]}
  ```

  The last two keys were added in 2d4ca23d (2026-03). Open PR #3607 argues they're useless and removes them again.
- **Timestamps.** The server ignores the device-sent `LastModified`/`PriorityTimestamp` and stamps `now()` on every write. Open PR #3607 shows this causes intermittent "Sync to last page read?" popups. The fix it proposes: store the device's `LastModified` as both LM and PT, and drop `onupdate` on PT. See Lesson 9.
- **The Calibre read column is not synced.** Kobo status lives only in `book_read_link`. When the admin configures "Link read status to a Calibre custom column" (`config_read_column`), the web UI writes the custom column instead, and Kobo and web status diverge (#3079, #2997, #2740 are open).
- Unknown book: `redirect_or_proxy_request()`. That's a 307 to the store for GET, a proxied request for PUT, or `{}` when the proxy is off.

---

## 5. Metadata and entitlement JSON

### 5.1 `BookEntitlement`

```json
{ "Accessibility": "Full",
  "ActivePeriod": {"From": ts(now_utc)},
  "Created": ts(book.timestamp),
  "CrossRevisionId": uuid, "Id": uuid, "RevisionId": uuid,
  "IsRemoved": <archived for this user>,       // true ⇒ device removes the book
  "IsHiddenFromArchive": false, "IsLocked": false,
  "LastModified": ts(book.last_modified),
  "OriginCategory": "Imported",
  "Status": "Active" }
```

### 5.2 `BookMetadata`

```json
{ "Categories": ["00000000-0000-0000-0000-000000000001"],
  "CoverImageId": "<book uuid>",                      // CWA: "<uuid>-<cover mtime>" cache-buster
  "CrossRevisionId": uuid, "EntitlementId": uuid, "RevisionId": uuid, "WorkId": uuid,
  "CurrentDisplayPrice": {"CurrencyCode": "USD", "TotalAmount": 0},
  "CurrentLoveDisplayPrice": {"TotalAmount": 0},
  "Description": "<first comments row, HTML>" | null,
  "DownloadUrls": [ ... ],
  "ExternalIds": [],
  "Genre": "00000000-0000-0000-0000-000000000001",
  "IsEligibleForKoboLove": false, "IsInternetArchive": false, "IsPreOrder": false, "IsSocialEnabled": true,
  "Language": "<ISO 639-1>",                          // isoLanguages part3→part1, default "en" (8a511250, cd143b7e)
  "PhoneticPronunciations": {},
  "PublicationDate": ts(book.pubdate),
  "Publisher": {"Imprint": "", "Name": "<first publisher>" | null},
  "Title": "...",
  "Contributors": ["Author A", "Author B"],            // or null if no authors
  "ContributorRoles": [{"Name": "Author A"}, {"Name": "Author B"}],   // no "Role" key (7640ac1b removed "Role":"Author")
  "Series": { "Name": "...", "Number": <series_index float, or 1 if not float>,
              "NumberFloat": float(...), "Id": str(uuid3(NAMESPACE_DNS, series_name)) } }   // only if series
```

- Timestamps everywhere use `strftime("%Y-%m-%dT%H:%M:%SZ")`, which has no fractional seconds. A non-datetime value (malformed DB) falls back to `now` (58d485cb / #1702).
- Only the first author, first publisher, first series and first language are used, except that all authors go into `Contributors`.
- `get_seriesindex` returns `series_index` if it is a float, else 1. Index `0.0` now stays `0`; it used to become `1` via `or 1` (bf89bbc8 / #3204). A missing index used to crash `float(None)` (013793f9 / #1391).
- Encoding: the sync endpoint uses `json.dumps` (default `ensure_ascii`, so `\uXXXX` escapes) plus an explicit `charset=utf-8`. The metadata endpoint uses `ensure_ascii=False`. eb2e816b says this finally made UTF-8 titles show up correctly. **For ABS: always send `Content-Type: application/json; charset=utf-8`.**

### 5.3 `DownloadUrls`

```python
KOBO_FORMATS = {"KEPUB": ["KEPUB"], "EPUB": ["EPUB3", "EPUB"]}
kepub = [d for d in book.data if d.format == 'KEPUB']
for d in (kepub or book.data):              # c25f6d7c: if a KEPUB exists, ONLY the KEPUB is offered
    if d.format not in KOBO_FORMATS: continue
    for kobo_format in KOBO_FORMATS[d.format]:
        if get_epub_layout(book, d) == 'pre-paginated': kobo_format = 'EPUB3FL'   # 4eaa9413, fixed layout
        append({"Format": kobo_format, "Size": d.uncompressed_size,
                "Url": <download url for d.format.lower()>, "Platform": "Generic"})
        # zipfile.BadZipfile / FileNotFoundError → log, skip this entry
```

- With EPUB only, the list has **two** entries, `EPUB3` and `EPUB`, both pointing to `/download/<id>/epub`.
- With a KEPUB, the list has one `KEPUB` entry pointing to `/download/<id>/kepub`.
- Fixed-layout books get `EPUB3FL`, which replaces both EPUB entries.
- No `DrmType`. It's commented out as "Not required". CWA sends `"DrmType": "None"`.
- `get_epub_layout` reads `rendition:layout` from the OPF. Any parse error (missing `container.xml`, bad XML, `IndexError`, `OSError`, `UnicodeDecodeError`) returns `None`, i.e. reflowable (2f12b2e3 / #2840, 34c6010a, 80bcfb12).
- Download URL:
  - not proxied: `"{scheme}://{host_without_port}:{config_external_port}/kobo/{token}/download/{book_id}/{fmt_lower}"`
  - proxied: `url_for("kobo.download_book", auth_token=token, book_id=id, book_format=fmt, _external=True)`
- **The id in the URL is the numeric Calibre book id, not the uuid.**
- The download handler (`get_download_link(..., client="kobo")`):
  - uses the filtered book lookup, `allow_show_archived=True`, so archived books can still be downloaded (91a21aba)
  - records the download
  - sets `Content-Disposition: attachment; filename="<title - author>.kepub"; filename*=UTF-8''...` and, **for the `kobo` client and the `kepub` format, rewrites `.kepub` to `.kepub.epub`**
  - Inference: the device's KEPUB renderer selection keys on the `.kepub.epub` extension. The same rename was later applied to web download links for the Kobo browser (4d79c593 / #2990).
  - If "embed metadata" is on, the file is rewritten into a temp dir at download time; for KEPUB this means content.opf is replaced.

### 5.4 Covers

`GET /kobo/<token>/<uuid>/<w>/<h>[/<Quality>]/<isGreyscale>/image.jpg`

- Thumbnail size from `int(height)`: `>1000` gives LARGE, `>500` gives MEDIUM, otherwise SMALL. A `ValueError` (for example a literal `{height}`) falls back to SMALL (7818c4a7, d253804a / #2865, d2860fc3 / c2474aa9 / #2523).
- The cover comes from the thumbnail cache if present, else from the original `cover.jpg`.
- Unknown uuid or no cover: with the proxy on, a 307 to `https://cdn.kobo.com/book-images/{uuid}/{w}/{h}/false/image.jpg`. This keeps store-purchased books' covers working (5f0c7737, 400c7456 / #2371: the old Akamai host started returning 404s). With the proxy off, a 404 (it used to be `{}`).
- `CoverImageId` is the book uuid and **never changes**, so devices keep stale covers after cover edits (#2509 is open). CWA appends `-<cover.jpg mtime>` and strips the suffix on request (CWA 5fb41dd / CWA #1050).
- CWA also generates JPEG thumbnails alongside WebP, and serves JPEG to Kobo, because Kobo can't render WebP.

---

## 6. KEPUB conversion

- This needs `config_kepubifypath`, the directory containing the `kepubify` binary. Names are platform-specific: `kepubify-windows-64Bit.exe`, `kepubify-linux-64bit`, `kepubify-linux-32bit`, `kepubify`.
- Triggers in upstream:
  1. **During sync**, for each book in the current page that has EPUB but no KEPUB. `helper.convert_book_format(id, book_path, 'EPUB', 'KEPUB', user)` enqueues a background `TaskConvert` and returns immediately.
  2. When the token page is opened (`/kobo_auth/generate_auth_token`), for **every** book in the library. This caused mass conversions every time a new user generated a token (#2446; f85b587d only fixed a typo). CWA removed it.
  3. Manual conversion in the book edit page.
- Conversion (`TaskConvert._convert_kepubify`):
  - The command is `[kepubify, <src>.epub, '-o', <dir>, '-i']`.
  - kepubify writes `*.kepub.epub`. CW globs `glob.escape(basename) + "*.kepub.epub"`; the escape was added because `[`/`]` in titles broke the glob (deb1ff37). It requires exactly one match, then copies the result to `<book dir>/<name>.kepub`.
  - It adds a `Data` row with format `KEPUB`. **On success it calls `remove_synced_book(book_id, all=True)`** for KEPUB/EPUB/EPUB3 targets. This forces the next sync to re-send the book as a `ChangedEntitlement`, now with the KEPUB URL.
  - If the target file already exists, it just registers the `Data` row.
- Result: on the first sync the device gets EPUB URLs (`EPUB3` + `EPUB`). After conversion completes, the next sync swaps it for KEPUB. If the user downloaded the EPUB in between, the device may hold the EPUB version. Inference: the swap shows up as a changed entitlement, and the device may re-download.
- Failure behavior: conversion errors only show in the task list and the log. The book keeps syncing as EPUB. Nothing is retried automatically except on the next sync, which re-enqueues the conversion if KEPUB is still missing.
- Caching: the KEPUB is stored permanently in the Calibre library as a real format, so conversion is one-time. With "embed metadata" on, metadata is re-injected into a temp copy at download time (`do_kepubify_metadata_replace`), and the temp file is removed after the response.
- CWA (CWA 8467b51): there is no conversion at sync time. If kepubify is configured, the EPUB-only book is **advertised as `KEPUB`** with a `/download/<id>/kepub` URL. The download handler then converts on demand with `blocking=True` (120 s timeout). If conversion fails or times out, it serves the EPUB. There is exactly one `DownloadUrl`.

---

## 7. Store proxy

- Toggle: `config_kobo_proxy` ("Proxy unknown requests to Kobo Store"). Kobo sync itself is gated by `config_kobo_sync` (a restart is required; the blueprint is only registered when enabled).
- Store URL:

  ```python
  __, __, p = request.full_path.rpartition("/kobo/"); __, __, path = p.rstrip("?").partition("/")
  url = "https://storeapi.kobo.com/" + path
  ```

  This strips the token segment, keeps the query string, and removes Flask's trailing `?`.
- `redirect_or_proxy_request()`:
  - Proxy on, `GET`: **307 redirect** to the store URL. The device follows it with its own headers, so the CW server never sees store auth.
  - Proxy on, any other method: the **server proxies** the request itself, because "The Kobo device turns other request types into GET requests on redirects".
  - Outgoing request: `requests.request(method, url, headers=Headers(request.headers) minus "Host", data=request.get_data(), allow_redirects=False, timeout=(2, 10))`.
  - Response: the store body and status, with the store headers minus `connection`, `content-encoding`, `content-length` and `transfer-encoding`. `requests` already decompressed the body, hence dropping `content-encoding`.
  - Any exception is logged. Auth routes fall back to the dummy auth response. Everything else falls through to `{}` (46f111cd / #3334).
  - Proxy off: `{}` 200.
- `make_request_to_kobo_store(sync_token)` is also used by init and sync. For sync, it replaces `x-kobo-synctoken` with the raw store token.
- Covers for unknown books: 307 to `https://cdn.kobo.com/book-images/...` (§5.4).
- OverDrive and library borrowing need several store routes forwarded: `/v1/products/books/external/<ids>` (e2325f7b), `POST /v1/library/<id>/preview` (0eb8583d), and the `/v1/products/<path>` catch-all (65409505, which also covers `featuredforkoboplus` for the Discover tab).

---

## 8. Deletion, archive and removal semantics

| Event | Effect |
|---|---|
| User deletes a book **on the device** (`DELETE /v1/library/<uuid>`) | `change_archived_books(book_id, True)` sets `ArchivedBook(user, book).is_archived=True` and `last_modified=now`. If archived, `remove_synced_book` follows. The next sync re-emits it with `IsRemoved: true`, and it is marked synced again. The book is now **hidden from that user's web UI** (archived). Returns 204. |
| User archives or unarchives in the web UI (`/ajax/togglearchived`, bulk edit, `archiveselectedbooks`) | Toggles or sets the archive state and removes the synced row. The next sync sends `IsRemoved: true` or `false`. Unarchiving re-adds the book to the device. |
| Book edited in CW with a `last_modified` change | `remove_synced_book(id, all=True)`, for all users. Re-sent as `ChangedEntitlement`. |
| Book edited **externally in Calibre desktop** | Nothing: `kobo_synced_books` isn't touched, so it is **never re-sent** (#2816, #3133 open). |
| A KEPUB/EPUB/EPUB3 format is deleted, or a conversion into one succeeds | `remove_synced_book(id, all=True)`, so it is re-sent. |
| Book **hard-deleted** from the library | `delete_whole_book` removes shelves, `ReadBook` and downloads, but **does not tell the device**. There's no tombstone, so the device keeps the book. The UI warns to archive first if Kobo sync is on (f9dbc6bc). The `SyncToken` docstring admits deletions can't be detected. |
| Book removed from a kobo-sync shelf (shelf mode) | Upstream: only `ChangedTag` (the collection shrinks); **the book stays on the device** (#2685 open). CWA: a set difference `synced − allowed` emits `ChangedEntitlement` with `IsRemoved: true` and removes the synced rows (§10). |
| Shelf deleted in CW, or via device `DELETE /v1/library/tags/<id>` | `delete_shelf_helper` deletes the shelf and its `BookShelf` rows and inserts a `ShelfArchive(uuid, user_id)`. The next sync emits `DeletedTag` and deletes the `ShelfArchive` row. 9296d355 fixed a bug that wrote `user_id = uuid`, so tombstones never matched. |
| Shelf "sync to Kobo" unchecked (shelf mode) | Intended: `DeletedTag`. Upstream bug: the filter `not ub.Shelf.kobo_sync` never matches. The books stay too. |
| Shelf "sync to Kobo" checked | Any `ShelfArchive` tombstone with that uuid is deleted, so it won't be deleted on the device. |
| User switches "only selected shelves" from off to on | `update_on_sync_shelfs`: **archives** every synced book that isn't on a kobo-sync shelf (`is_archived=True`, which also hides it in the web UI), deletes the synced rows, and adds `ShelfArchive` for every shelf with `kobo_sync == 0`. Switching from on to off does nothing. |
| Admin or user presses "Force full kobo sync" | Deletes **all** `kobo_synced_books` rows for the user. The next sync sees zero rows and resets the token's book and reading-state timestamps, so the whole library is re-sent (mostly as `NewEntitlement`). Tags are not reset. |
| User deleted | `RemoteAuthToken`, `KoboSyncedBooks`, `ArchivedBook` and the `KoboReadingState` cascade are all deleted. |
| Calibre library path changed (different DB) | Wipes `ArchivedBook`, `ReadBook`, `BookShelf`, `KoboReadingState`, `KoboStatistics` and `KoboSyncedBooks` for everyone (bd01e840 / #620). |

Also: since 6208d5e2 (2026-04, a security fix), `get_book_by_uuid` applies `common_filters()` **without** `allow_show_archived`. Inference: a state, metadata, delete or cover request for an *archived* or restricted book now looks "unknown". GET requests are redirected to the store (or get `{}`), and covers get a 404.

---

## 9. Lessons learned and bug fixes (most important)

Each entry gives the symptom, root cause, fix and a takeaway for ABS. Hashes are upstream unless marked CWA.

1. **The "synced" mark is optimistic, and a crash or abort loses books.** `kobo_synced_books` is written while the response is being built. If the device fails to apply the batch, those books are never re-sent. A 401 or 404 on some unrelated endpoint can make the device abort its whole sync queue. CWA v4.0.6 had exactly this: shelves synced, but no books, and the books were marked as sent (CWA #1470), so users had to press "Force full sync". *ABS: tie "delivered" state to a token/checkpoint the device echoes back. That means: commit a checkpoint only when the next request presents the token from the previous response. Also provide a per-device "resync everything" escape hatch.*

2. **Shelf-mode pagination truncation (open: #3218, #3352, #3584).** Symptom: 1,500 books but only about 250 synced; "Force full sync" doesn't help. Cause: the cursor `books_last_modified` advances to `max(last_modified, date_added)` of a page ordered by `Books.id`. The next page filters `date_added > cursor`, so lower-dated unsent books vanish. *ABS: the cursor must use the same key as the ORDER BY (keyset pagination, e.g. `(updatedAt, id)`), or use a pure "not yet delivered" set. Never mix both.*

3. **`continue` with a stale cursor.** c25afdc2 through 5edde53f tried keyset pagination with `books_last_id` while also filtering `last_modified >= token`, and saw loops and skipped books. The fix was the `kobo_synced_books` table (5edde53f, 2021-10). PR #3584 notes `cont_sync = bool(remaining)` is right only because the count is re-evaluated after inserting into the synced table. *ABS: compute "has more" after marking the page, or use `limit+1`.*

4. **`books_last_created` must not advance mid-pagination** (25422b34 / #2195). New-vs-changed is decided by `ts_created > token.books_last_created`. If page 1 advanced it, page-2 books with older timestamps would be labeled "Changed". The device ignores a `ChangedEntitlement` for a book it never had, so new books didn't appear. Fix: only advance it on the final page. *ABS: if the device doesn't have the book, always use `NewEntitlement`.*

5. **A first or forced sync must ignore the token.** 25422b34 / #2195: after a token reset or a device reset, the device still had an old SyncToken, and with timestamp filters nothing was re-sent. Fix: with zero synced rows, reset the token timestamps to `min`.

6. **The SyncToken header must be a str, not bytes** (b1d7bade / #3017). The header was `b'eyJ...'`. The device echoed it, parsing failed, every sync was "first", and the endless loop drained the battery. Also: tolerate missing base64 padding, and treat a dotted token as a Kobo store token.

7. **The device Host header drops the port, and reverse proxies vary** (0411d4a8, e0483882, ee3541d7 / #1470, 4e8b814e IPv6, CWA d44bf37).
   - Absolute URLs built from `Host` lacked the port, so CW added `config_external_port`.
   - Behind Cloudflare Tunnel, only `X-Forwarded-Proto` arrives, so `is_proxied` was false and the *internal* port 8083 was appended. Every download and cover URL broke.
   - IPv6 hosts need bracket handling.

   *ABS: build every device-facing URL from an explicit, configurable public base URL, with a sane fallback.*

8. **`library_sync` in the init resources must point to the server** (a9713bd4, 2026-02). With the proxy on, the store's resources pointed `library_sync` at `storeapi.kobo.com`, so newer firmware synced against Kobo and got no local books. *ABS: override `library_sync`, `image_host`, `image_url_template` and `image_url_quality_template` (CWA also overrides `oauth_host` and `reading_services_host`).*

9. **"Sync to last page read?" popups.** These came from several causes over time:
   - (a) The progress float/int mismatch: the device sent `50`, the server returned `50.0`. Fix: send whole numbers as ints (d229f711; the popup issue is tracked as #3596).
   - (b) Progress `0` was dropped by a truthiness check (a4bf0285, CWA 3f16313).
   - (c) Still open: the server stamps `PriorityTimestamp=now()` on every PUT, so the next GET returns a PT the device never saw. Proposed fix: echo the device's own `LastModified` as both LM and PT, and stop `onupdate` on PT (#3607). The real Kobo cloud reportedly returns PT = LM = the device's timestamp.
   - Also #2304 and #1439.

   *ABS: store the device-provided timestamps verbatim and return them unchanged. Round-trip numbers exactly as received.*

10. **Reading position only works with KEPUB.** #1439: books synced as EPUB reopened at the chapter start, because plain EPUB uses a different renderer with no Kobo spans. Fix: prefer KEPUB, and offer only the KEPUB when one exists (15bb0ce9, c25f6d7c). *ABS: offer KEPUB whenever possible (on-demand kepubify like CWA), and name the download `.kepub.epub` (c2474aa9 / #2990).*

11. **The PUT state body is partially populated.** A missing `Location` gave a `KeyError` and a 400 (CWA #1213). Upstream also needs `Statistics`, `StatusInfo` and `CurrentBookmark` present. *ABS: treat every sub-object and key as optional. Never 400 on a missing key, because the device would retry forever or drop the update.*

12. **Unknown series index, timestamps and languages crash the sync.** Missing `series_index` (013793f9 / #1391), `series_index` 0 becoming 1 (bf89bbc8 / #3204), a malformed timestamp in the DB (58d485cb / #1702), `ReadBook.last_modified` NULL after migration (ac37483d / #1391), missing `timestamp`/`date_added` (CWA 8c521f3 / CWA #983, CWA c337926 / CWA #1011). *ABS: a single bad book must never 500 the whole sync. Sanitize per item with fallbacks (`now`, `datetime.min`, `en`, index 1).*

13. **404s on unknown device endpoints abort the sync.** Routes were added over time for `/v1/assets` (#2849), `POST /v1/library/<x>` ("Synchronize Notebooks" on pen devices, c289cb5d / 2f6322b0), `/v1/auth/refresh` (#3492), `/v1/user/add-device` (upstream #2477 is open; CWA 93d5b98 / CWA #1476), `/v1/user/loyalty/benefits`, `/v1/analytics/gettests`, `/v1/deals`, `/v1/affiliate`, `/v1/products/featured...` (7640ac1b), and the `/v1/products/<path>` catch-all (65409505). *ABS: add a catch-all under the Kobo prefix that proxies (proxy on) or returns `{}`/`[]` 200 (proxy off) for any unknown path, and log it.*

14. **Modern firmware in fully local mode needs OAuth and reading-services stubs** (CWA 8ab6d99 / CWA #879, CWA aa97e0e for firmware 4.45+):
    - point `oauth_host` at the server
    - answer `/oauth/token|refresh|*` with dummy tokens
    - serve `/.well-known/openid-configuration` with a `token_endpoint`, because without one the device requests "a new token from ''" and cancels the sync queue
    - point `reading_services_host` at the server root, and answer `/api/v3/content/checkforchanges` (`[]`), `/api/v3/content/*/annotations` and `/api/internal/notebooks*` (`{"data":[],"totalResults":0}`), and `/api/UserStorage/*` (`{}`)

    The device strips the path from `reading_services_host`, so these must be served at the **site root**, not under the token prefix.

15. **Multi-user correctness: every query must be scoped by `user_id`** (e880238c, df670795 / #2230, a56e071a / #2043, 0feb62c1). Missing user filters on `KoboSyncedBooks`, `ArchivedBook`, shelf joins and `ReadBook` made one user's sync state break another's ("Syncing more than one kobo device breaks syncing").

16. **`add_synced_books` must be idempotent** (e880238c). Duplicate inserts and commit errors happened. (In 5edde53f, it used to be inserted *before* the entitlement was built.)

17. **Archive toggle semantics** (fd5ab0ef, e31763d3, 2afce664). `state if state else not current` made `state=False` act as a *toggle*, so unarchiving sometimes archived. Fix: `state if state is not None else not current`. CWA still has the buggy version (§10). The device DELETE must archive and remove the synced row (7640ac1b), or the `IsRemoved` entitlement is never sent.

18. **Cover requests with odd sizes** (d253804a / #2865): `height` arrived as a string, and `height > 1000` raised `TypeError`, breaking cover sync. Parse leniently. Pick the thumbnail size by requested height (#2523). Proxy unknown covers to `cdn.kobo.com/book-images` (the old Akamai host returns 404s: 400c7456 / #2371, 01108aac removed the trailing slash). Serve JPEG, not WebP (CWA).

19. **Stale covers on the device** (#2509, CWA #1050): `CoverImageId` must change when the cover changes. CWA uses `<uuid>-<mtime>` and normalizes on request. *ABS: version the image id.*

20. **Metadata changes are never pushed** (#2816, #3133, #3381 open). Only CW-UI edits re-send the book, and the device may not refresh metadata from a `ChangedEntitlement` at all. PR #3381 proposes `ChangedProductMetadata`. *ABS: detect `updatedAt > checkpoint`, and emit `ChangedEntitlement` and/or `ChangedProductMetadata` (verify on a device which one works).*

21. **Unicode** (7640ac1b, eb2e816b): JSON must be sent with `charset=utf-8`. Flask's `jsonify` output got mangled on the device.

22. **Download permission and restrictions** (d272f434, c6dadbe7 / #1938, 6208d5e2): a user without the download role gets a 403 on sync. Per-user content restrictions must apply to sync, and to *every* uuid lookup (6208d5e2 fixed a bypass in 2026-04).

23. **Mass KEPUB conversion side effects** (#2446, CWA #817): converting the whole library from the token page, or inline in sync, made sync and token generation very slow. CWA defers conversion to download time (CWA 8467b51). Watch out for stale temp files serving the **wrong book** (CWA 7536a81: the export helper picked the first file with a matching extension, so multiple books downloaded with the same content). Use unique temp names and match them exactly.

24. **Sync performance** (CWA 8467b51): N+1 queries per book (`get_or_create_reading_state` and lazy relations) cost about 11 s plus 3 s on 5,000 books. Eager-load authors, publishers, series, languages, comments and formats. Don't create reading-state rows during sync.

25. **The store proxy must be robust** (df3eb40e, 46f111cd / #3334). Use a timeout of (2 s, 10 s). Strip hop-by-hop headers and `content-encoding`. Fall back to the dummy auth when the store is unreachable. Only merge store sync results on the final local page (f22e4d99). Redirect GETs with 307, and proxy other methods server-side, because the device turns redirected POST/PUT/DELETE into GET. `ExpiredToken` from the store's init must be passed through so the device re-authenticates (CWA). Without that, users can stay stuck (#2318).

26. **Per-user (not per-device) tracking.** A second device on the same account gets nothing, because every book is already in `kobo_synced_books` for that user. (Inference from the query; consistent with many "second device doesn't sync" reports, e.g. #2477.) *ABS: key delivery state by device (or by token), not by user.*

27. **Shelf tombstones** (9296d355, 50d703e2, df670795): `ShelfArchive.user_id` was set to the uuid. Tombstones were filtered by timestamp and missed. Now all of them are sent every sync and deleted immediately. The `not Column` filter bug means "unsync shelf" never deletes the tag (fixed in CWA 0d4f800 / #1443).

28. **Date-type pitfalls (SQLite).** Calibre stores timestamps as strings with `+00:00`, and CW compares naive datetimes. String comparison without `func.datetime()` gave wrong results ("treating last_modified as a string ... fails because of the +00:00 suffix", removed comment in c25afdc2; `func.datetime` added in a56e071a). `.replace(tzinfo=None)` is sprinkled everywhere. *ABS: normalize all timestamps to UTC epoch ms before comparing.*

29. **Auth token IDOR** (d5980541; CWA 4875df6 / CWA #1303): any logged-in user could create or read another user's Kobo token and sign a device in as them.

30. **Fixed-layout EPUBs** (4eaa9413 / #1219): advertise the format as `EPUB3FL` when `rendition:layout = pre-paginated`, or the device renders them badly. EPUB parse failures must not break sync (2f12b2e3 / #2840, 34c6010a, 80bcfb12; CWA 4e9b83e strips the BOM before parsing the OPF, CWA #975).

31. **Dummy auth body handling** (a1899bf5 / #2603, CWA 93d5b98): devices without a Kobo account send no `UserKey`, and some auth calls have no JSON body at all.

32. **Rate limiter interplay** (2472e03a, e3bf369a, 8bdd95fc, fbed304d, a9782640 / #3691): a blanket 3/min limit on the blueprint broke normal syncs, which make dozens of calls per minute. CW clears the limit after successful token auth. a9782640 removed stray `log.error` limiter debug lines that leaked into logs. *ABS: rate-limit only failed token lookups.*

---

## 10. CWA differences (vs upstream at the compared commits)

**Added or fixed in CWA:**

- **Two-way shelf deletion (shelf mode).** Each sync computes `synced_ids − (books on kobo_sync shelves ∪ magic-shelf books)`. For each, it emits `ChangedEntitlement` with `IsRemoved: true` and deletes the synced rows. This fixes upstream #2685.
- **Shelf-mode query changes:**
  - It uses outer joins.
  - It also selects books whose `Books.last_modified > token.books_last_modified`, so modified books re-sync if not already in the synced table.
  - It is ordered by `last_modified`, then `id`.
  - It no longer folds `date_added` into `books_last_modified`.
- **Magic shelves** (saved searches) can be synced as collections (`config_kobo_sync_magic_shelves`, `MagicShelf.kobo_sync`). Disabled ones are always emitted as `DeletedTag`. Their books count as allowed (CWA #976).
- **Device DELETE:**
  - In shelf mode: don't archive (the shelf decides).
  - Otherwise: archive only if the user can see archived books (`check_visibility(32768)`).
  - Always remove the synced row.

  Side effect (inference): in all-books mode, without archive visibility, the book is re-sent on the next sync and reappears on the device.
- **Performance:** eager-loads relations, outer-joins `KoboReadingState` instead of get-or-create (no row creation during sync), and drops inline KEPUB conversion (CWA 8467b51).
- **On-demand KEPUB:** advertises `KEPUB` for EPUB-only books when kepubify exists, and converts blocking on download (120 s timeout) with an EPUB fallback. Only one `DownloadUrl`, plus `"DrmType": "None"`.
- **Cover cache-busting:** `CoverImageId = "<uuid>-<cover mtime>"` (GDrive: `last_modified` epoch). The suffix is normalized away on request (`kobo_cover_cache.py`).
- **Timestamp guards:** `get_kobo_created_ts()` falls back from timestamp to date_added to last_modified to `datetime.min`.
- **Bookmark:** `.get("Location")`, and sets `current_bookmark.last_modified = now`.
- **OAuth for unregistered or local devices:** `/oauth/*` dummy tokens (both `snake_case` and `PascalCase` fields, `expires_in: 3600`) and OIDC discovery.
- **Init changes:** `oauth_host` is rewritten when the proxy is off; `ExpiredToken` passthrough when the proxy is on.
- **Reading-services root stubs** (`before_app_request`), with `reading_services_host` pointed at the server.
- **`POST /v1/user/add-device`** handled like `/v1/auth/device` (CWA #1476), and `get_json(silent=True)`.
- **Extra routes:** `/v1/categories/<x>`, `/featured`, `/products` and `/v1/products/featuredforkoboplus/`.
- **Hardcover integration:** progress is pushed on PUT state, and annotations are synced via the reading-services host when enabled.
- **External port:** optional, falling back to `DEFAULT_PORT`. `is_proxied` is also set from `X-Forwarded-Proto`/`X-Scheme`.
- **Rate limiting:** `limiter.check()` returns 429, and keys are cleared via the storage API.
- **Activity logging** (KOBO_SYNC events).
- **`NATIVE_KOBO_RESOURCES`:** more keys, https URLs, several feature flags set to `True`, and `sign_in_page` changed to `https://auth.kobobooks.com/ActivateOnWeb`. The `kobo_resources.txt` override was removed.

**Upstream fixes CWA lacks or regressed** (at `4fc2c44`):

- No `_clean_progress` int coercion. It returns raw floats, so it's susceptible to the d229f711 popup.
- No `LastModified`/`PriorityTimestamp` in the PUT response (this matches what #3607 recommends anyway).
- Init doesn't override `library_sync` (missing a9713bd4).
- No `/v1/products/<path:dummy>` catch-all (it uses explicit routes instead).
- `redirect_or_proxy_request` has no try/except (missing 46f111cd), so a store outage 500s on proxied POSTs. `HandleAuthRequest` has its own try.
- `change_archived_books` uses `state if state else not ...`, the toggle bug that upstream fixed in e31763d3/2afce664.

---

## 11. Known open problems and quirks

- Shelf-mode pagination truncation (#3218, #3352, PR #3584). See Lesson 2.
- "Sync to last page read?" popups from the server-stamped `PriorityTimestamp` (#3596, PR #3607).
- External metadata edits are never re-synced; there's no `ChangedProductMetadata` (#2816, #3133, PR #3381).
- Cover changes don't reach the device (#2509).
- Removing a book from a synced shelf leaves it on the device (#2685).
- "Unsync shelf" never emits `DeletedTag` (the `not ub.Shelf.kobo_sync` bug).
- Read status isn't linked to a Calibre custom read column (#3079, #2997, #2740).
- Annotations and highlights aren't synced; the device can lose them after a re-download (#2155, #1484, #2610).
- Hard deletes aren't propagated; there are no tombstones for books.
- Per-user, not per-device, state means a second device gets nothing (inference; Lesson 26).
- `/v1/user/add-device` 404s upstream (#2477). CWA fixed it.
- Large libraries: the response size per page (100 books with full metadata, plus all changed tags, plus up to 100 reading states) can still be heavy for old devices (#1276).
- Locale header `*` from the device produces a harmless "Could not parse locale" log (#3364, #3731).
- In "all books" mode, a book with multiple Kobo formats may produce duplicate rows (inference; no `distinct()`).
- The SyncToken data schema validation is a no-op (it validates the wrong object), and the version is compared as a string.
- `get_book_by_uuid` now hides archived books (6208d5e2). Inference: state and metadata requests for archived books get redirected or stubbed.
- `get_or_create_reading_state` creates `ReadBook` and `KoboReadingState` rows for every synced book (upstream), which inflates `app.db` and makes every new entitlement carry a `ReadingState`.
- Tags aren't paginated, and the `ShelfArchive` tombstone is deleted the moment it's emitted (no ack).
- `x-kobo-sync`/`x-kobo-sync-mode`/`x-kobo-recent-reads` are copied from the store even when they're `None` (inference: they may serialize as the literal `None`).

---

## 12. Suggested ABS clone checklist (derived; not CW code)

1. Per-device token in the URL path. Use a public-base-URL setting for every absolute URL. Add a catch-all for unknown Kobo paths. Also add root-level reading-services stubs and OAuth/OIDC stubs for local mode.
2. Init: start from a native resource dict (with an override file). Override `library_sync`, the image templates, `oauth_host` and `reading_services_host`. Send the header `x-kobo-apitoken: e30=`.
3. Sync:
   - base64 JSON token in a str header, using keyset pagination over a single ordered key plus `id`
   - page size ≤ 100
   - set `x-kobo-sync: continue` iff more remain
   - New vs Changed based on whether *this device* has received the book
   - removals via `IsRemoved: true`
   - full collection membership in tags
   - DeletedTag tombstones
   - per-item error isolation
4. Reading state: optional keys everywhere. Store device timestamps verbatim, and echo the device's `LastModified` as both LM and PT. Round-trip numbers exactly (int stays int). Map `ReadyToRead`, `Reading` and `Finished`.
5. Downloads: prefer KEPUB, generated on demand with an EPUB fallback. Use the `.kepub.epub` filename. Advertise `EPUB3FL` for fixed layout. Covers in JPEG with a versioned `CoverImageId`.
6. Store proxy (optional): 307 for GET; server-side proxying for other methods with a (2 s, 10 s) timeout; strip hop-by-hop headers; merge the store sync on the final page and keep the raw store token inside ours.
