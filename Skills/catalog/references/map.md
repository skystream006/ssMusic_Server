# Catalog discovery map

| Topic | Starting source and anchors | Closest tests |
| --- | --- | --- |
| Identity, membership, order, reconciliation, shared search helpers | [library](/home/runner/work/ssMusic_Server/ssMusic_Server/src/library.js): `songKey`, `getPlaylistTracks`, `getPlaylistIds`, `reconcileLibrary`, `normalizeSearchText` | [library](/home/runner/work/ssMusic_Server/ssMusic_Server/test/library.test.js); shared UI consumers if changed |
| Downloaded counts versus companion files | library: `countDownloadedFiles`, `isNoVocals`, `findNoVocals` | [downloadedFiles](/home/runner/work/ssMusic_Server/ssMusic_Server/test/downloadedFiles.test.js), [jobSorting](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobSorting.test.js), affected songActions tests |
| Preferences and whole-library validation/versioning | [libraryStore](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryStore.js): `getPreferences`, `setTheme`, `getLibrary`, `validateLibrary`, `setLibrary`, `preserveHiddenLibraryState` | library, [privacy](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacy.test.js) for hidden-state changes |
| Entry/folder edits and playlist privacy | libraryStore: `mutateLibraryEntry`, `moveLibraryPlaylists`, `setLibraryPlaylistPrivacy` | library, privacy |
| Membership changes, compact reorder, unlink versus delete | libraryStore: `linkLibraryJob`, `addLibraryJobFiles`, `transferLibrarySongs`, `reorderLibrarySong`, `moveLibrarySong`, `removeLibrarySongLink`, `lockLibraryFile` | library; [jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobManager.test.js) when physical deletion changes |
| HTTP library/preferences and pagination contract | [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js): `getLibraryJobs`, `mutateUserLibrary`; `/api/preferences`, `/api/library`, `/api/library/tracks`, entry/link/move/reorder/transfer routes | [jobRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobRoutes.test.js), [postgres](/home/runner/work/ssMusic_Server/ssMusic_Server/test/postgres.test.js) as affected |
| Catalog-key search validation, companion results and URLs | [songSearch](/home/runner/work/ssMusic_Server/ssMusic_Server/src/songSearch.js): **only** `searchSongs`; library search-text helpers | [privacyRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacyRoutes.test.js); postgres for index migration changes |
| Projected/paged catalog storage | [postgresCatalog](/home/runner/work/ssMusic_Server/ssMusic_Server/src/postgresCatalog.js): `rebuildPostgresLibrary`, `readPostgresLibrary`, `pagePostgresTracks` | postgres, library; consult persistence for implementation changes |

## Boundaries

The source job and personal library organization are not interchangeable.
Determine which one a requested field belongs to before editing a schema or UI.
Bulk imports/exports/backups are library-transfer; actual file deletion is
media-jobs; credential allowlists and visibility are access.

Configuration: database settings are supplied by runtime/persistence; no separate
catalog service exists. Relevant
[README](/home/runner/work/ssMusic_Server/ssMusic_Server/README.md) headings:
Personal music library; All Music Pagination; Add job files to a playlist;
Search API key; PostgreSQL storage and limits.

Use [invariants](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/catalog/references/invariants.md)
for the selected behavior. UI consumers include MusicLibrary/MusicPlayer, but do
not load them for a server-only validation change.
