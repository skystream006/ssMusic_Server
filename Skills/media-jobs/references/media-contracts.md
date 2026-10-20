# Media contracts

## Paths and media delivery

[media](/home/runner/work/ssMusic_Server/ssMusic_Server/src/media.js) is the
browser-safe extension classifier. Audio, playable media and MP3 tag-editable
files are different sets; do not use `isSongFile` as a synonym for all videos.

[jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/src/jobManager.js)
allows a filename or the reserved `[NoVocals]/filename` form through
`isValidJobFileName`. Preserve lexical validation, stored inventory membership,
regular-file checks and realpath containment; string-prefix path tests alone
are insufficient.

`resolveRequestedFile` in
[server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js) performs
authenticated owner/grant/privacy checks before stream, download, artwork,
metadata and lyrics access. Preserve URL encoding of complete filenames,
including the NoVocals slash. Streams rely on Express file serving for ranges
and HEAD; avoid replacing it with an unbounded whole-file buffer.
Public share delivery has a separate resolver owned by access.

## Metadata, ratings and lyrics

[music](/home/runner/work/ssMusic_Server/ssMusic_Server/src/music.js) keeps summary
reads bounded and cached by file stat. List summaries do not contain artwork or
lyrics. `readSongMetadata` and `updateSongMetadata` support explicit lyric
inclusion; the metadata endpoint calls with lyrics excluded, while `/lyrics/:name`
loads them explicitly. Do not eagerly parse lyric frames for ordinary metadata
or list requests.

Preserve audio bytes and unrelated ID3 frames when editing fields. Ratings use
the existing POPM/star conversion. SYLT and USLT update/clear independently.
`setSongMetadata` additionally stores transcription lock state and refreshes the
indexed summary. Access owns the Shared rating-only exception; do not infer broad
edit permissions from the metadata route alone.

## Artwork and thumbnails

[artworkThumbnails](/home/runner/work/ssMusic_Server/ssMusic_Server/src/artworkThumbnails.js)
encodes 192×192 AVIF, with a bounded output size and source-stat/version signature.
Use `readSongThumbnail`, `refreshSongThumbnail` and `removeSongThumbnail`; do not
introduce a second cache. Cache entries are under the runtime data directory,
keyed by resolved path and source revision. Generation is bounded, coalesced,
rechecked against source changes and published atomically.

Downloaded covers are preferred for video thumbnails before frame extraction.
Audio artwork reads validate embedded MIME/type/size; missing audio can use the
bundled fallback only when requested. Source covers in the hidden thumbnails
directory are not downloadable media inventory.

`listJobFiles` returns revisioned artwork/stream URLs. Mutation paths refresh
thumbnails only after successful song persistence. Do not make every catalog
search decode media. Admin regeneration uses bounded catalog iteration in
[thumbnailMaintenance](/home/runner/work/ssMusic_Server/ssMusic_Server/src/thumbnailMaintenance.js).
Frontend owns lazy image rendering and status polling.

## Upload and transcription boundaries

[replaceFile](/home/runner/work/ssMusic_Server/ssMusic_Server/src/replaceFile.js)
accepts one bounded multipart audio file, with no extra fields, matching the
original extension/format. It calls `validateImportAudio` with probing required.
Consult [transfer contracts](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/library-transfer/references/interchange-and-backups.md)
before changing that shared validator.

[transcription](/home/runner/work/ssMusic_Server/ssMusic_Server/src/transcription.js)
sends media to configured `TRANSCRIPTION_ENDPOINT`, validates option types,
uses a bounded timeout/response size and validates returned audio/ZIP entries.
Preserve archive traversal/duplicate/type checks and the required original-file
rule except for the explicit NoVocals-only contract. Language choices come from
[transcriptionLanguages](/home/runner/work/ssMusic_Server/ssMusic_Server/src/transcriptionLanguages.js),
also imported by the UI.
