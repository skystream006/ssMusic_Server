# Library-transfer discovery map

| Topic | Starting source and anchors | Closest tests |
| --- | --- | --- |
| Multipart uploads, owner selection, progress | [libraryImport](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryImport.js): `handleLibraryImport`, `resolveImportUser`, `createImportUploadCounter`, `getImportProgress`, `importUploadedFiles` | [libraryImport](/home/runner/work/ssMusic_Server/ssMusic_Server/test/libraryImport.test.js), [jobRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobRoutes.test.js) for HTTP |
| Media content/probe validation reused by replacement | libraryImport: `validateImportAudio`, `validateImportMedia`, `probeImportAudio` | libraryImport, [replaceFile](/home/runner/work/ssMusic_Server/ssMusic_Server/test/replaceFile.test.js) |
| Local files, archive safety and completed-file handling | libraryImport: `resolveLocalImportFile`, `listLocalImportFiles`, `extractImportMedia`, `archiveLocalImportFiles` | libraryImport, jobRoutes for local admin routes |
| iTunes mapping, conversion, deduplication and rollback | libraryImport: `parseItunesImport`, `convertItunesWav`, `importItunesLibrary` | libraryImport |
| Playlist ZIP, iTunes/Android export layout | [libraryExport](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryExport.js): `exportOptions`, `prepareLibraryExport`, `resolveSong`, `writeLibraryExport` | [libraryExport](/home/runner/work/ssMusic_Server/ssMusic_Server/test/libraryExport.test.js) |
| Backup scheduling, latest archive, progress, privacy revision | [libraryBackup](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryBackup.js): `nextBackupTime`, `createLibraryBackupService`, nested `saveSchedule`, `start`, `openLatest`, `runDue` | [libraryBackup](/home/runner/work/ssMusic_Server/ssMusic_Server/test/libraryBackup.test.js) |
| HTTP transfer endpoints | [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js): `/api/jobs/import` and local/logs/playlists variants; `/api/library/backup`, `/backup/schedule`, `/export`, `/playlists/:id/download` | jobRoutes, affected transfer suite |

## Dependencies and configuration

Imports use `importJobFiles` and job cleanup from media-jobs, plus catalog
membership/versioning. Exports use canonical catalog ordering and media metadata.
Backup service state is persisted through the database, while scheduling locks
and open-file reader tracking are process-local.

Environment: `IMPORT_STORAGE_ROOT`, `IMPORT_STORAGE_COMPLETED_ROOT`,
`LIBRARY_BACKUP_ROOT`, and `FFMPEG_PATH` for probing/conversion.
Compose bind-mount settings belong to runtime. An iTunes export destination is a
client extraction path embedded in XML, not a server write target.

The [scheduler](/home/runner/work/ssMusic_Server/ssMusic_Server/src/scheduler.js)
calls `runDue`; runtime owns that timer, not backup date calculations.
Frontend owns ImportMusic and export/backup dialogs.

Relevant [README](/home/runner/work/ssMusic_Server/ssMusic_Server/README.md) headings:
Import media; Import from a Windows folder; Download a playlist; Export your
library; Scheduled backups.

Read [interchange and backups](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/library-transfer/references/interchange-and-backups.md)
selectively. A change to format generation need not load account enrollment or
the entire downloader.
