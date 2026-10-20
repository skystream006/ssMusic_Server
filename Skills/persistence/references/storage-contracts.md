# Storage contracts

This is the persistence contract reference. Use the [map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/references/map.md) to locate a symbol; [common defaults](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md) and [shared validation](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md) supply repository-wide rules.

## Driver and transaction boundary

- PostgreSQL 17 is the documented requirement, not an optional SQLite backend. Startup creates the schema and `pg_trgm`; the configured role needs the corresponding privileges. Sources: `/home/runner/work/ssMusic_Server/ssMusic_Server/README.md`, “Database storage” (lines 1746–1757); `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresSchema.sql`, `CREATE EXTENSION` (line 1).
- `/home/runner/work/ssMusic_Server/ssMusic_Server/src/database.js`: `openDatabase` caches by `DATABASE_URL`, or host/port/database/user (lines 52–55); `closeDatabases` clears the cache and asynchronously closes every handle (lines 58–61). Set test connection settings before importing modules that open a handle.
- `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgres.js`: `createPostgresDatabase` prefers `DATABASE_URL`, otherwise the `PG*` settings; the pool defaults to 10 clients with a 30-second connection timeout (lines 5–18). Its parser deliberately returns JSON/JSONB as **text** (OIDs 114/3802) and bigint as `Number` (OID 20). Callers explicitly `JSON.parse`/`JSON.stringify`; switching to automatic JSON decoding breaks that contract.
- The returned `prepare(sql).all/get/run` methods are asynchronous and use `$1`-style bound values. `all` returns rows, `get` the first row or `undefined`, and `run` `{ changes: rowCount }`; `exec` is asynchronous too (lines 38–51). Do not treat this facade as synchronous or concatenate request values into SQL.
- `ready` starts schema installation immediately in a transaction; queries and mutations await it (lines 21–40). `withTransaction` pins a pool client using `AsyncLocalStorage`; awaited queries inside the callback use that client, while unrelated queries use the pool (lines 20–55).
- Transactions use `pg_advisory_xact_lock(735916, lock)`: schema installation uses lock `0`, mutation transactions lock `1`. Nested `withTransaction` calls reuse the enclosing transaction, **not savepoints**. The outer transaction commits or rolls back and releases its client; await all work before returning. This serializes wrapped mutations, not arbitrary standalone queries.

## Identity, normalized rows, and cascades

Source: `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresSchema.sql`, named tables below (lines 3–143).

| Stored identity / projection | Contract |
| --- | --- |
| `users`, `credentials`, `sessions` | Credentials and sessions reference users with cascading deletion. User updates must not replace the user row and erase credentials/session identity. |
| `jobs` / `job_users` | Job header JSONB is separate from per-file rows. `job_users` indexes initiating/contributing users; its job FK cascades, but `user_id` is not a user FK. Do not assume all ownership strings imply a live account. |
| `songs` | Primary key is `(job_id, name)`, not filename alone. Rows retain file order, media type, JSONB metadata/transcription, search text, and optional karaoke stem. |
| `library_entries` / `library_memberships` | Membership identity includes user, playlist, job, and name. Both the library-entry FK and the composite song FK cascade on deletion. |
| `user_songs` / `user_catalog` | Per-user unique-song projection and stored total/revision support catalog paging; they are derived, not a new source of membership semantics. |
| `media_shares` / `playlist_shares` | Song shares reference the composite song identity; playlist shares can reference a job. Creator and source deletion cascade. Keep token hashes and existing identities intact on ordinary updates. |
| `library_backups` | Intentionally has no user FK: records survive account deletion. Do not add a cascade as generic schema cleanup; retention policy belongs to library-transfer. |

`writeUser` in `/home/runner/work/ssMusic_Server/ssMusic_Server/src/database.js` (lines 10–45) upserts users and credentials, rejects reuse of a credential by another user, and preserves credential last-use state during ordinary writes. It does not itself wrap all statements in a transaction; account operations requiring atomicity supply one.

`writePostgresJob` in `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresCatalog.js` (lines 127–165) writes a header with `files: []`; metadata/transcription for inventoried files lives in `songs`, while non-inventory entries can remain in the header. `hydrate` and `readPostgresJob` reconstruct the public job shape (lines 5–19). Preserve that round-trip instead of putting the full inventory back into header JSON.

**Never implement ordinary job/song updates as delete-and-reinsert.** Cascading song FKs would silently remove memberships and public song links. The writer upserts existing songs, updates only distinct row values, and deletes only names actually removed from inventory. Deletion is a real lifecycle operation: `deletePostgresJob` captures affected users, deletes the job, then rebuilds their catalogs in one transaction (lines 284–289).

## Projection updates versus metadata updates

Source: `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresCatalog.js`, `rebuildPostgresLibrary`, `writePostgresJob`, `updatePostgresSong` (lines 92–165, 271–281).

- Inventory changes include file order; ownership changes compare initiator/contributor membership. Either rebuilds catalogs for the union of old/new users. Otherwise a job write bumps `user_catalog.revision` without deleting library entries.
- `updatePostgresSong` accepts only `metadata` or `transcription`, updates the affected song, refreshes metadata search text when needed, sets job `updatedAt`, and bumps affected catalog revisions. It does not rebuild memberships; a missing song produces 404.
- `rebuildPostgresLibrary` reads the user's saved preferences and jobs, calls `reconcileLibrary`/`getPlaylistTracks`/`getPlaylistIds`, replaces derived entries/memberships and unique-song rows, and increments catalog revision. It does not start its own transaction: callers must keep a multi-table rebuild atomic.
- The membership algorithm remains in `/home/runner/work/ssMusic_Server/ssMusic_Server/src/library.js` (`songKey`, `getPlaylistTracks`, `reconcileLibrary`, lines 42–44, 66–150). Validation, optimistic `library_version`, and organization writes remain in `/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryStore.js` (`writeLibrary`, `setLibrary`, lines 180–209). Changing SQL projection mechanics must not redefine those catalog semantics.
- `insertRows` batches JSON recordsets in chunks of 1,000 (lines 35–39). Full affected-user rebuilds and legacy full-job reads still materialize inventories; indexed paging is not a guarantee that every operation is bounded.

## Paging, search, and visibility

Source: `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresCatalog.js`, `readPostgresLibrary`, `pagePostgresTracks`, `postgresPageJobs` (lines 167–269, 292–311).

- Keep owner scope and **viewer** identity distinct. Use `entryVisibilitySql`, `fileVisibilitySql`, and `jobVisibilitySql` from `/home/runner/work/ssMusic_Server/ssMusic_Server/src/privacy.js` (lines 107–145) before counts/paging. `attachPrivacyAliases`, `canReadFile`, and `visibleJob` govern hydrated results and companion files; persistence consumes these access-owned rules.
- Selected folders/playlists deduplicate tracks by composite source identity in playlist order. The all-library path uses `user_songs` with visible alternate memberships where the canonical entry is hidden. Preserve stable job/name tie-breakers for saved, name, and rating sorts.
- Search uses normalized `songs.search_text` and escapes literal backslash, `%`, and `_` in a bound `LIKE` value. Normalization is catalog-owned: `/home/runner/work/ssMusic_Server/ssMusic_Server/src/library.js`, `normalizeSearchText`/`songSearchText` (lines 33–39).
- Keep `songs_search` (trigram GIN), `library_memberships_page`, and `user_songs_page` aligned with access patterns in `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresSchema.sql` (lines 88, 123, 132). Page rows hydrate metadata/transcription and needed companions; do not load every job merely to return a page.
- `GET /api/library/tracks` in `/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js` (lines 354–383) defaults to 50, caps requested page size at 1,000, and validates sort/search inputs. With an explicit selection and no paging parameters, it intentionally passes `pageSize: null` and returns the legacy unpaged shape. All-library requests remain paginated.
- Deep numbered pages use SQL offsets. Visibility-aware counts and large rebuilds can still be costly; do not claim constant-time or measured million-song performance without the relevant measurements.

## Startup and named migrations

- `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresSchema.sql` executes on each new driver initialization, using repeatable DDL and the `migrations` table. Existing schema markers include `postgres-schema-v1` and the guarded `karaoke-playlist-references-v1` backfill (lines 66–70, 143).
- `/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresCatalog.js`: `indexPostgresSongMetadata` uses `song-metadata-search-v1`; `normalizePostgresSearchIndex` uses `song-search-normalization-v1` (lines 41–90). Both walk composite-key batches of 500 and mark completion after processing. Search normalization compares old text before updating and leaves metadata unchanged.
- Invocation is a media-jobs startup responsibility: `/home/runner/work/ssMusic_Server/ssMusic_Server/src/jobManager.js` calls the metadata/search migration helpers after `loadJobs` at module initialization (lines 91–96). Do not assume importing a helper consumer is read-only.
- For changed persisted representations, design an explicit, repeatable migration and verify existing rows, not just a fresh schema. No separate migration CLI is defined in `/home/runner/work/ssMusic_Server/ssMusic_Server/package.json`.

## Focused verification and fixture safety

Follow [shared validation](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md) for invocation. Start with the two database tests in the [map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/references/map.md); add only tests for changed boundary contracts.

- `/home/runner/work/ssMusic_Server/ssMusic_Server/scripts/run-tests.mjs` requires the `ssmusic_test` database name, provisions PostgreSQL 17 via Docker when `TEST_POSTGRES_URL` is absent, and runs test files serially (lines 17–49).
- `/home/runner/work/ssMusic_Server/ssMusic_Server/test-support/postgres.js`, `createTestDatabase` (lines 8–46), additionally creates a unique database per fixture, switches `DATABASE_URL`, and restores it on cleanup after closing cached connections and force-dropping the fixture database. The test role must be allowed to create/drop databases; use only a disposable service.
- `/home/runner/work/ssMusic_Server/ssMusic_Server/test/postgres.test.js` includes rollback, normalized round-trip, metadata-only update, migration idempotence, and authenticated HTTP workflows. Its million-song case (lines 287 onward) requires `TEST_POSTGRES_SCALE=1`; it measures synthetic database records, not physical media or concurrent playback.
- Fixture consumers and helper imports can open connections or perform startup recovery. Establish test settings before importing side-effectful consumers. Documentation-only changes do not require executing any of these tests.
