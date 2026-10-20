# Job and mutation lifecycle

## Initialization and download execution

[jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/src/jobManager.js)
opens the database and performs restart recovery/index initialization at module
load. Existing tests create isolated storage before dynamically importing it.
Use those fixtures; do not inspect behavior by importing it against a live database.

`createJob` validates options, normalizes the URL and creates the record inside a
transaction before starting background execution. Audio and video are distinct
formats. Playlist URL normalization and single-video normalization are distinct
contracts in [utils](/home/runner/work/ssMusic_Server/ssMusic_Server/src/utils.js).
Duplicate handling must not reveal inaccessible source jobs.

`executeJob` waits for the maintenance gate, persists running state, obtains
metadata and runs yt-dlp unless metadata-only. Preserve the download archive,
rerun output location and explicit format flags. Downloaded source covers are
handled separately from listed media. Finalization indexes metadata and persists
the job before refreshing thumbnails. Keep unavailable/private-video partial
completion distinct from unrelated command failures.

`loadJobs` marks interrupted queued/running downloads failed and sent
transcriptions interrupted. Do not introduce implied automatic resume behavior.
`runMaintenanceUpdate` waits for active downloads and blocks new starts while
updating yt-dlp/Deno. Runtime owns scheduling that operation, not its gate.

## Mutation coordination

`jobMutations`, `transcriptionQueues`, `deletingFiles` and `mutateJobFiles` provide
process-local coordination. `assertJobIsIdle` and per-file checks are not
interchangeable: metadata/transcription can have different allowed concurrency
than replacement or whole-job deletion. Preserve `finally` cleanup and queue
continuation after rejected operations.

Authorization comes from
[access policies](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/policies.md).
Job ownership/contributor permissions and private-file visibility are separate
checks. Same-output aliases can require additional mutation checks and coordinated
updates. Never use an administrator role to bypass private-source visibility.

## Replacement and deletion

`replaceJobFile` stages the upload next to the source, validates current source
identity, retains a rollback link, replaces bytes and transactionally updates
affected aliases. Preserve `(jobId, name)`, permissions, companion linkage and
the transcription-lock flag; do not delete/reinsert the song. The new file's
mtime must advance so clients observe the replacement. Refresh thumbnails after
successful persistence; clean staging and reservations on success or failure.

`deleteJobFile` distinguishes membership removal from physical deletion.
Consult catalog's membership contract before changing link counting or
`lockLibraryFile`. Preserve private retained companions, including alias-only
companions. Delete thumbnail cache entries with the correct resolved source key.
Do not claim filesystem deletion is a reversible database-only transaction.

## Transcription

`transcribeJobFile` validates options and locks, queues per job, persists sent
state and calls `executeTranscription`. Submitted lyrics are sent to the service,
not copied into the stored options; `lyricsIncluded` records their presence.
`NoVocalsOnly` is a special accompaniment path, including its lock exception.

[replaceTranscribedFiles](/home/runner/work/ssMusic_Server/ssMusic_Server/src/transcription.js)
stages new bytes, backs up existing targets and restores files/inventory on
failure. Companion files live in the reserved NoVocals subdirectory. Keep privacy
inheritance, companion links and thumbnail publication consistent with persistence.

## KaraokeParty

[karaoke](/home/runner/work/ssMusic_Server/ssMusic_Server/src/karaoke.js) serializes
mutations per normalized video URL. External playlist IDs are not library entry
IDs. Persist idempotent `(playlist_id, video_url)` references; repeated add must
not create extra references/downloads. Failed duplicates can rerun on add, not
on status polling.

Removing a reference deletes a video only when it is the final reference, owned
by the service account and not retained by other library/contributor references.
Access owns the catalog-key exception and ExtServer account lifecycle.
