# Interchange and backup contracts

## Import ownership and safe input

[libraryImport](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryImport.js)
distinguishes the acting account from the target library owner. Shared accounts
cannot import; importing for another account requires administrator authorization
and a valid target. Existing private destinations still need access checks.
Do not turn an administrator-selected owner into a privacy bypass.

Uploads and local imports have distinct size/count policies. Preserve streaming
extraction, XML/media validation, regular-file requirements, symlink/traversal
checks, encrypted-entry rejection and cleanup. Local-mode exemptions from upload
limits do not waive path/content validation. Do not open arbitrary paths supplied
in an XML document; resolve against the selected validated media inventory.

`validateImportAudio`/`validateImportMedia` combine extension/type checks with
FFmpeg/ffprobe validation as required. `validateImportAudio` is also used by
media-jobs replacement with `requireProbe`; changing it requires replacement
regression coverage. Do not create a weaker parallel validator.

`resolveLocalImportFile` accepts only eligible regular files inside the import
root. Completed local imports move to a distinct completion root using collision
handling and rollback. Keep local progress scoped to its owner/import ID.

## iTunes import and catalog effects

`parseItunesImport` plans playlists; `importItunesLibrary` deduplicates shared
source files across playlists, creates jobs, and records ordered memberships
through catalog APIs. Preserve WAV conversion and mislabeled MP2 handling where
applicable, without applying those special cases to arbitrary standalone uploads.

On failure, remove created jobs and temporary converted files. Do not discard
pre-existing library state or physical sources still used by other memberships.
Use [catalog invariants](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/catalog/references/invariants.md)
for ordering/identity and
[job lifecycle](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/references/lifecycle.md)
for actual file mutation.

## Export and playlist download

[libraryExport](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryExport.js)
uses `getPlaylistTracks` and `getPlaylistIds`, deduplicates source tracks, and
preserves saved order. `prepareLibraryExport` supports an internal playlist
download mode in addition to iTunes/Android library exports.

Playlist ZIPs include playable audio/video and relative M3U8 paths. Library
iTunes/Android exports select audio; iTunes rejects unsupported codecs. Retain
collision-free archive paths, XML escaping and playlist newline handling.
The validated iTunes destination is an absolute local extraction location in
generated file URLs; it is not fetched or written by the server.

Source files must resolve inside their real job directory. HTTP/service callers
are responsible for passing an authorized library/job set; export preparation
alone does not authenticate a user. `writeLibraryExport` creates exclusive private
output, streams the ZIP and removes partial output on failure. Library archives
are not substitutes for PostgreSQL, TLS and deployment backups.

## Backup service

[libraryBackup](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryBackup.js)
stores schedules/status in PostgreSQL and ZIPs under the configured backup root
in hashed user directories. Its injected clock, archive writer and library loader
enable isolated tests. Preserve bounded concurrent work, same-user overlap
rejection, reader-aware cleanup and the previously successful archive on failure.

`start` writes a partial archive, finalizes it and publishes latest metadata only
after authorization/privacy rechecks. `openLatest` rechecks current eligibility
and privacy revision before returning a handle with a release callback. The HTTP
caller must release it even when streaming fails. Never serve stale backups
after privacy changes without regeneration.

`nextBackupTime` uses UTC for monthly/weekly schedules. Monthly dayOfMonth is
1–31; short months clamp the computed date without changing the saved day.
`runDue` advances from the current time, so downtime produces one catch-up run,
not a replay of every missed date. Preserve legacy daily-to-monthly migration,
disabled/revoked handling and interrupted-run recovery.

Runtime owns timer wiring and storage mounts. Its daily binary-maintenance
schedule uses server-local time and must not be reused for backup date math.
