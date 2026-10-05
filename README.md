# ssMusic_Server

ssMusic is a personal music and video library with yt-dlp download
jobs from YouTube and YouTube Music URLs.

Submitted YouTube links containing a `list` query parameter are normalized to
`https://music.youtube.com/playlist?list=PLAYLIST_ID` before duplicate detection and
downloading. Video IDs, tracking parameters, and fragments are discarded for these
playlist submissions; links without `list` are unchanged.

## Renamed deployments

Keep the existing PostgreSQL database, Docker volumes, `.env`, and TLS files
when upgrading. Before moving a Docker checkout to a differently named folder,
set `COMPOSE_PROJECT_NAME` in `.env` to the original project name shown by
`docker compose ls`. This keeps the same `data`, `output`, and `postgres_data`
volumes instead of selecting a fresh database or empty media library.
Keep `PASSKEY_RP_ID`, `PASSKEY_ORIGIN`, and any secondary passkey settings
unchanged: existing passkeys are bound to those hostnames and origins, not the
application or repository name. No account or media data migration is required.

## Audio and video downloads

On **Jobs > Start a download**, choose **Audio (MP3)** or **Video (MP4)** in
**Format**, paste a YouTube URL, and choose **Add job**. Audio remains the default.
Standard YouTube, mobile YouTube, YouTube Music, and `youtu.be` links are accepted.
Links containing a `list` query parameter download the complete playlist.

Video jobs download video with audio, preferring MP4/M4A streams, and use FFmpeg
to merge or remux the result to MP4. Reruns keep the original format. The same URL
can have separate audio and video jobs; duplicates within a format offer the
existing job's normal rerun or details action.

`POST /api/jobs` accepts `downloadType: "audio"` (default) or `"video"`, for example
`{ "url": "https://www.youtube.com/watch?v=VIDEO_ID", "downloadType": "video" }`.

## Playlist and file privacy

Playlists and files are nonprivate by default, retaining their existing access
rules. Only the owning user can change privacy. A private playlist and its source
files are accessible only to that owner, not contributors, linked users, Shared
accounts, other administrators, public-link recipients, or search API keys.
A private file remains private when linked into another playlist; generated
no-vocals versions cannot bypass the original file's privacy.
Retained no-vocals files stay private when their private original is deleted.

Use the owner-only privacy actions in Jobs or Music Library to mark a playlist
or file private, or make it nonprivate again. The **Individual Songs** and
**Individual Videos** playlists have per-library privacy: hiding one hides that
playlist and its memberships from other library readers, but does not itself
make its source files private. Mark the files private to restrict their direct
media URLs everywhere.

The authenticated privacy endpoints accept `{ "private": true }` or
`{ "private": false }` (JSON booleans):

- `PATCH /api/jobs/:id/privacy` — playlist/source job privacy.
- `PATCH /api/jobs/:id/files/:name/privacy` — file privacy; URL-encode the entire filename.
- `PATCH /api/library/playlists/:id/privacy` — playlist privacy, including the
  current user's Individual Songs/Videos playlists.

Privacy applies to catalogs, searches, metadata, lyrics, artwork, streams,
downloads, exports, and mutations. Making a playlist nonprivate does not clear
its files' individual privacy flags. Existing public links stop working while
the source is private, and new public links cannot be created for private media.
Previously downloaded copies or streams already in progress cannot be recalled.
Saved ZIP backups made before privacy support, or before another owner's privacy
settings changed, must be regenerated before downloading; an export is also
rejected if those settings change while it is being prepared.

## Read-only song search API

Set `SEARCH_API_KEY` in `.env` to a long, randomly generated secret and restart
the server. For example, generate a value with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Leaving the setting empty disables key access. Docker Compose passes the
setting to the app. Send it over HTTPS in the `X-API-Key` header on **every**
request; keys in query strings, cookies, or `X-PAT` are not accepted.

`GET /api/songs/search?q=artist&page=1&pageSize=50` searches audio and video
across all libraries/source jobs, excluding private playlists and files. Search is
case- and accent-insensitive literal substring matching over indexed filename, playlist
title, title, artist, album, performer, genre, year, and track/disc metadata.
For example, `yeu dung so dau` matches `Yêu Đừng Sợ Đau`; Vietnamese `đ` is matched
as `d`. Accented and decomposed-Unicode queries work too. The same matching applies
to library track searches. A one-time startup migration normalizes existing search
indexes in batches without rereading media or changing displayed metadata; no
reimport or redownload is needed.
`q` is optional (empty lists accessible media), with a maximum of 200 characters.
Pages start at 1; `pageSize` defaults to 50 and is limited to 100.

The response is `{ "files": [...], "page": 1, "pageSize": 50, "total": 42,
"totalPages": 1 }`. Files contain `jobId`, `name`, available summary metadata,
`playlistTitle`, and relative `streamUrl`, `downloadUrl`, `artworkUrl`, and
`lyricsUrl` links. Send the same header when following these URLs; it is never
embedded in a returned URL. Media streams support ranges and HEAD requests.
Private media is rechecked on each request, including previously returned URLs.

All song search results provide an `artworkUrl`. Audio URLs include `?fallback=1`:
supported embedded MP3 artwork is preferred, and songs with no supported cover
receive a bundled 96 by 96 WebP ssMusic thumbnail. Other artwork requests retain
their existing missing-cover behavior unless the fallback is requested.

Video results provide frame thumbnails (MP4, M4V, MOV, WebM, and OGV).
Video thumbnails are 96 by 96 WebP images generated
with FFmpeg on the first artwork request and reused from the disk thumbnail cache.
Changing a video invalidates its cached image; deleting the video or job removes it.
Search itself does not decode videos. Send `X-API-Key` when fetching a thumbnail,
just as for the stream and download URLs. Private media remains protected even
when a fallback thumbnail is requested.

The key also permits:

- `GET /api/libraries` — approved library owners as `{ "users": [{ "id", "name" }] }`.
- `GET /api/library?userId=<id>` — a nonprivate, read-only library catalog.
- `GET /api/library/tracks?userId=<id>` — the existing track pagination,
  `entryId`, and `search` parameters, filtered by privacy.
- `GET`/`HEAD /api/jobs/:id/stream/:name`, `/download/:name`,
  `/artwork/:name`, and `/lyrics/:name` — nonprivate media, including videos
  where supported by the endpoint.

No writes, account/admin operations, job logs, or backup downloads are allowed.
Supplying a key alongside a session or PAT never upgrades its read-only scope.
Treat this key as a server-wide read credential, not a public browser key;
rotate it by replacing the environment value and restarting the server.

## Public media links

Open a song's **Share Media** action, review the privacy warning, then choose
**Generate public link** and **Copy link**. Recipients can open the link without
signing in, play the song, or choose **Save file** on the public page to download it.
Synchronized (SYLT) lyrics use the music player's highlighting and autoscroll;
select a lyric line to seek. Choose **Fullscreen lyrics** to expand the lyrics
without interrupting playback, switch between SYLT and plain-text USLT, and
return using the close button or Escape. A full-page overlay is available when
the browser does not support native fullscreen.

Approved song owners, contributors, and administrators can create a public link
with `POST /api/jobs/:id/files/:name/share` (URL-encode the complete filename).
It returns `{ "url": "/share/<token>" }`. Anyone with this link can listen to and
download that one audio file without signing in, and see its embedded metadata,
artwork, rating, and lyrics. Other songs, playlists, job details, and editing
remain private; videos and non-audio files cannot be shared this way.

For a playlist, open its row's pencil, choose **Share Playlist** in **Edit playlist**,
then **Generate public link** and **Copy link**. Save any pending edits first.
`POST /api/library/playlists/:id/share` returns `{ "url": "/share/playlist/<token>" }`.
The public page lists songs in the creator's saved playlist order, 50 per page,
with playback, previous/next controls, individual downloads, metadata, and lyrics.
Opening the page does not autoplay; choosing a song starts playback and completed
songs advance to the next, including across pages. Recipients cannot edit the playlist.

Playlist links follow current membership and order rather than a frozen copy.
Only public audio files the creator is allowed to share are included; linked songs
belonging to other users are excluded unless the creator has contributor or admin
permission. Private playlists cannot be shared. Making a playlist or song private,
removing a song, or revoking the creator's access blocks subsequent public requests.
Moving, renaming, and rebuilding the library retain links; deleting the backing job
permanently removes its links, including if the same job ID is later restored.
`GET /api/public/playlists/:token?page=1` returns the title, pagination, and tracks
with opaque IDs and public metadata, stream, and download URLs. Internal job IDs,
filesystem paths, and account details are not included.

Treat the link as a secret: recipients can forward it and downloaded copies
cannot be recalled. Links persist across restarts, have no scheduled expiry,
and only token hashes are stored in PostgreSQL. Deleting the source song/job or
creator invalidates its links; access is also denied whenever the creator is
not approved, becomes a shared account, or loses owner/contributor/admin access.
Public responses request no caching, no referrer disclosure, and no indexing;
these headers are not a substitute for keeping links private. Avoid recording
share URLs in proxy logs or analytics.

Public shared-media pages always use the midnight-blue dark palette, independently
of account appearance settings. Administrators can open **Admin > Shared links**
to browse accessible generated links, 50 per page, with the song or playlist, source job,
creator, and unique link ID. Use the delete icon and confirm to revoke a link.
Links to another owner's private media are omitted, even for administrators.
This blocks subsequent metadata, streaming, and download requests for that link;
the source file, other links, and already downloaded copies are unaffected.
Existing public URLs cannot be recovered because only token hashes are stored.

The admin-only API is `GET /api/admin/media-shares?page=1` and
`DELETE /api/admin/media-shares/:id`, using the ID returned by the listing.
Deletion returns HTTP 204, or 404 if the link is already gone.
Playlist rows include `kind: "playlist"` and use the same listing and deletion API.

`GET /api/public/media/:token` returns flat song metadata plus `name`,
`sizeBytes`, `streamUrl`, and `downloadUrl`; streaming supports HTTP ranges and
HEAD requests. Embedded tag, artwork, and lyric reading currently supports MP3;
other supported audio formats use a filename title and empty metadata defaults.
Public MP3 metadata reads only the leading ID3 tag, capped at 16 MiB; absent,
malformed, compressed, or oversized tags use those same defaults. At most four public metadata
requests run concurrently (including HEAD); additional requests receive HTTP 503
with `Retry-After: 1`. Playback support still depends on the browser's codecs.

## All Music Pagination

**All music** loads 50 tracks per page. Use the page controls above or below the
list to browse. Search matches filenames, titles, artists, albums, album artists,
genre, year, track/disc numbers, and playlist names across the whole library and
returns to page one when changed. Embedded MP3 tags are indexed during imports
and downloads. Existing songs receive a one-time, batched metadata index update
at server startup; searching does not scan audio files.
**Play page** queues the displayed page; browsing other pages does not replace
the active queue. Open an individual playlist to reorder its tracks.

`GET /api/library/tracks` defaults to page 1 with 50 tracks. It accepts `page`,
`pageSize` (1-100), and `search` (up to 200 characters), and returns `files`,
`version`, `page`, `pageSize`, `total`, and `totalPages`. Out-of-range pages are
clamped after library changes. File details are loaded only for the requested
page and its instrumental companions. Totals use the saved media inventory.
Requests with `entryId` retain the full playlist/folder response unless paging
parameters are supplied.

## Shuffle and repeat

Use **Shuffle** in the bottom playback bar or job player to toggle random
selection of the next track in the active queue, without changing playlist order.
The highlighted button indicates that shuffle is on.

The **Repeat** button cycles through **Off → Repeat queue → Repeat one song → Off**.
Repeat one shows a **1** on the repeat icon and restarts the current song when it
ends, even with shuffle enabled. **Next** and **Previous** still navigate normally;
repeat one does not force manual skips back to the same song. Repeat queue wraps
back to the first track at the end when shuffle is off. With shuffle on, playback
continues choosing another track while more than one is available.
These modes are shared between the job player and bottom bar for the current session.

## Metadata-only jobs

On **Jobs**, enter a YouTube URL and check **Download metadata only**
before choosing **Add job**. The initial run retrieves the title and playlist
song count, creates the output folder, and adds the job to your library without
downloading media. yt-dlp is still used for metadata lookup with `--skip-download`.
For playlists, use **Import media > Files** and select the new playlist to upload
your own audio or movies into its folder.

**Rerun** downloads media in the selected format, keeping existing files and
downloading missing ones. Metadata-only applies only to the initial run. Submitting
an existing URL with the same format still offers a normal media-downloading
rerun, even with the checkbox selected.
The API accepts the optional boolean `metadataOnly` on `POST /api/jobs`; it defaults
to `false`.

## Add job files to a playlist

On **Jobs**, use a job row's **Add all files to playlist** action, choose a
destination from your personal playlists, then select **Add all files**.
The action is available for jobs you own or contribute to that have downloaded
audio or movies. Only files currently available are added; metadata and other
non-media files are excluded.

Files remain in their source job and original playlist. Existing destination
entries are skipped, and new entries are appended in the job's saved order.
Membership is personal, so other users' playlists are unchanged. Deleting a
source file or losing access to its job also removes it from these playlists.

`POST /api/library/jobs/add` accepts `{version, jobId, playlistId}` and returns
the updated library and `addedCount`. Changes are atomic; stale versions return
409 without adding any files.

## Import media

On **Jobs**, choose **Import media**, or use the **Import media** upload button
in your library. From a selected playlist, that playlist is preselected.

- **Files:** select an existing playlist from your personal library, or check
    **Create New Playlist** and enter its name. Select audio or movie files and choose
    **Import**. MP3, MP2, WAV, FLAC, M4A, AAC, OGG, Opus, WMA, MP4, M4V, WebM, MOV
    and OGV are accepted; playback
    depends on your browser's codec support. Existing files are never overwritten.
- **iTunes library:** choose **Upload files** for an exported iTunes/Music library
    **XML** and a separate **ZIP**, or **Import from local** to select those files
    from the server's storage folder. Both files are required.
    Keep artist/album folders in the ZIP so tracks with identical filenames can
    be matched. XML locations are matched against ZIP path suffixes, never read
    from the server or fetched from the network. Missing or ambiguous media fails
    the import. Nonempty playlists and their track order are recreated; folders
    and empty playlists are not imported. Unassigned tracks go into **iTunes Library**.
    Tracks in several playlists are stored once and linked into each playlist. Internet-only
    tracks are skipped; unsupported local formats must be converted first.

Within one iTunes import, each matched archive file is copied only into the first
playlist that uses it. Other playlists link to that source, preserving their own
song order, including playlists containing only links. Multiple XML track IDs
matching the same archive file share it too; distinct archive files are kept
separate even if their names or contents match. Import totals count stored files,
not playlist memberships, and the import log shows copied and linked counts.
Metadata edits affect every link; removing a song from one playlist keeps its
source while other links remain. Deleting the entire source job still deletes its
files and their links. Existing imports are not deduplicated or migrated, separate
import runs are independent, and direct **Files** uploads still copy the selected files.

iTunes imports convert files detected as WAV to MP3, including WAV content
mislabeled with another supported extension. FFmpeg uses high-quality VBR MP3
encoding and copies supported metadata. XML matching uses the original filename;
playlists receive the `.mp3` replacement, with collisions renamed safely. Each
matched WAV is converted once, even when it belongs to several playlists.
The source ZIP and XML remain unchanged. Other media and direct **Files** uploads
are preserved without transcoding. Conversion requires FFmpeg (included in Docker).

New imports appear as completed jobs and in the destination user's music library;
imported jobs cannot be rerun. Regular users upload to their own library. Admins
can choose an approved User or Admin in the **Library owner** dropdown for Files,
uploaded iTunes libraries, and local imports. Shared, pending, and revoked accounts
cannot receive imports. Changing the owner reloads that user's playlist choices.
New jobs belong to the selected user, not the admin who starts the import. Imports
into existing playlists require the destination user's owner or contributor access.

MP2 (MPEG Layer II) audio is preserved for imports, downloads,
and public sharing; browsers without MP2 decoding support must save the file
and play it in a compatible player. Embedded metadata editing remains MP3-only.

iTunes ZIP imports also accept MP2 audio mislabeled with a `.mp3` extension.
After ffprobe confirms valid MP2 audio, the imported copy uses `.mp2` without
transcoding. XML matching uses the original filename; playlist links and order
are preserved, filename collisions are renamed safely, and the source ZIP/XML
remain unchanged. The import log records each correction. Direct **Files**
uploads still require an extension matching the audio contents.

Audio validation checks file contents, not just extensions. If the signature is
unrecognized (for example, an MP3 with leading padding), the importer uses
FFmpeg's `ffprobe` to confirm matching audio without changing the file. Docker
includes it; native installations need `npm run setup:ffmpeg` on Windows or
`FFMPEG_PATH` pointing to a directory containing `ffmpeg` and `ffprobe`.
An **Invalid or mismatched audio** error names the rejected file and gives the
detected format or probe failure. Re-export or convert genuinely damaged or
mislabeled files; renaming the extension alone does not convert audio.

iTunes imports display a live **Import log** in the dialog, retained on success
or failure. It includes ZIP extraction counts, track matching diagnostics, WAV conversions,
playlist creation, and cleanup. The import ID correlates with timestamped
`[library-import]` JSON entries in the server output. For Docker, follow these
with `docker compose logs -f app`. Full errors and stack traces are server-only;
logs can contain media paths and track names, so redact these before sharing.

`GET /api/jobs/import/logs/:importId` returns progress only to the account that
started the import, including an admin importing for another user. The log records
the selected library owner. Clients can supply a UUID via `POST /api/jobs/import?importId=<uuid>` to
poll while the request runs. The response also includes `importId`. Browser
logs retain the latest 200 entries of each account's latest import in memory,
for up to an hour after completion, with at most 20 accounts retained. Restarting
the server clears them; server output retains the full log according to your
logging configuration.

The dialog submits local imports with `?background=true`, receiving HTTP 202
with `{importId, status: "running"}` after the destination user and source files are checked. Processing
continues in the server process; the progress endpoint returns `status` and,
after cleanup, either `result` (imported file count and playlist IDs/titles) or
`error`. This avoids holding a request open through long local imports. Clients
without this option keep the synchronous HTTP 201 response. The dialog also
continues monitoring iTunes progress after a gateway/network interruption and
retries temporary log failures without resubmitting the import. Background imports
and their progress do not survive a server restart.

Browser uploads are limited to 2 GB total, 512 MB per audio or movie file, 20 MB XML,
and 1,000 directly uploaded files. Uploaded iTunes libraries are limited to
10,000 ZIP entries, 2,000 media tracks, 500 playlists, and 4 GB expanded media.
Playlist links do not add to the media-copy size limit. Limits are enforced by the server as well as the
upload form where applicable.

The admin-only **Import from local** option bypasses these upload and processing caps, allowing large
archives such as an 18 GB ZIP. File validation and path protections still apply.
Uploads and extraction use temporary disk storage, cleaned after each request;
XML parsing uses memory. Allow enough server disk space and memory for extracted
media and the single stored copy of each imported file. Browser/runtime limits and reverse-proxy timeouts may
still apply. Uncapped local ZIP extraction can exhaust server disk space.

File validation, unsafe archive-path checks, and the existing 5,000-entry
library constraint remain. There is no library-wide song-link count limit,
including for uploaded and local iTunes imports. Request-size limits and the
5,000-song limit per bulk transfer request still apply. At most two imports run
concurrently, one per initiating account and one writer per destination library.

The authenticated `POST /api/jobs/import` endpoint accepts multipart form data:
`mode=files`, `createNew=true`, `playlistTitle`, and repeated `files` fields;
or `createNew=false` with `playlistId` instead of `playlistTitle`.
For iTunes, send `mode=itunes`, `xml`, and `media`. Session cookies, PATs and
bearer tokens use the same authentication as the existing jobs API.
An optional `userId` selects the destination library; only admins may specify
another user. Omitting it imports into the authenticated user's library.
`GET /api/jobs/import/playlists?userId=<id>` returns only the eligible destination
playlists' IDs, titles, and statuses; regular users may query only their own account.

### Movie playback

Select a movie in a playlist or a job's file list to play it in the app. Movies
and audio share the playback queue, seek, volume, repeat and shuffle controls.
The movie viewer has native playback and fullscreen controls; minimize it and
use the dock's movie button to reopen it without restarting playback. Playback
continues while navigating within the app. Lyrics and transcription remain audio-only.

Codec support depends on the browser and operating system. MP4 with H.264/AAC
or WebM with VP8/VP9 and Opus are common choices; a supported extension does not
guarantee a supported codec. There is no automatic video conversion. Music library
exports remain audio-only; movies can be downloaded from their file actions or
the job's **Download all** archive.

### Import from a Windows folder

Docker Compose mounts `./import-storage` beside this project into the container
at `/app/import-storage`, with write access. For a checkout at `C:\DATA\ssMusic_Server`,
copy your ZIP and XML from USB directly into
`C:\DATA\ssMusic_Server\import-storage`. No access to Docker volumes is needed.
The folder is excluded from Git and from the Docker build context.

To use a different existing Windows folder, set this in `.env` (forward slashes
work with Docker Compose):

```dotenv
IMPORT_STORAGE_PATH=C:/MusicImports
IMPORT_STORAGE_COMPLETED_PATH=C:/MusicImportsCompleted
```

Rebuild/recreate the app after updating the code or mount:

```powershell
docker compose up -d --build
```

As an admin, open **Jobs > Import media > iTunes library > Import from local**,
choose the **Library owner**, refresh the file list, select the XML and ZIP, then
choose **Import**. Only regular files
directly in the folder are listed; subfolders and symbolic links are excluded.
Finish copying both files before importing, and do not replace them while an
import is running. After a successful local import, both source files move to
`./import-storage-completed` (or `IMPORT_STORAGE_COMPLETED_PATH` in Compose).
Existing completed files are never overwritten; name collisions receive a unique
suffix. Failed imports leave the source files available to retry. An archive
failure rolls back the imported playlists. Both folders must be writable.

Local import sends only filenames to the server, so an 18 GB ZIP does not pass
through the browser or incur an extra uploaded ZIP copy. Extraction and imported
media still need server disk space and processing time; keep the page open
until completion. Reverse proxies may need longer response timeouts. Only admins
can list and import from this shared folder, so place only intended music
imports there. Archiving across separate volumes temporarily needs space for a
second copy of the XML and ZIP.

For native Node execution, `IMPORT_STORAGE_ROOT` chooses the folder; its default
is `./import-storage`. In Compose, `IMPORT_STORAGE_ROOT` stays at the container
path and `IMPORT_STORAGE_PATH` selects the host folder. Native execution can set
`IMPORT_STORAGE_COMPLETED_ROOT`; it defaults to `import-storage-completed` beside
the source folder. Compose mounts the completed folder at
`/app/import-storage-completed`. The completed folder must differ from the source.

`GET /api/jobs/import/local` returns `xmlFiles` and `zipFiles` with names and
sizes. For local imports, `POST /api/jobs/import` accepts JSON:
`{"mode":"itunes","source":"local","xmlName":"Library.xml","zipName":"itunes.zip"}`.
Include `userId` to assign the local import to another eligible user. Both local
endpoints require an authenticated admin (session cookie, Bearer session, or admin PAT).
Non-admin local listings and submissions return `403`.

## Download a playlist

Select a playlist on the music page and choose **Download playlist (ZIP)** beside
the track search. The ZIP contains that playlist's current audio and video files,
including moved and linked tracks, plus an M3U8 playlist in the saved track order.
Search filters and checkbox selections do not limit the download. Original files,
embedded tags, lyrics and artwork are retained without transcoding.

Extract the whole ZIP, keeping the `.m3u8` file beside the `Media/` folder, then
open the playlist in a player supporting UTF-8 M3U8 with relative paths. Individual
Songs and empty playlists are supported. Pending downloads are not included.
The browser downloads directly; errors open in a separate tab without leaving
the music page. Playlist downloads do not create or replace your library backup.

`GET /api/library/playlists/:id/download` requires authentication and access to the
selected playlist. Add `?userId=<library-owner-id>` for an accepted linked library
or a library granted to a Shared account. Revoked access is checked on each request.

## Export your library

Choose **Export library** on the music page. Select **Latest export (backup)** to
download the saved ZIP without rebuilding it, or **New export**, then **iTunes**
or **Android (M3U8)** and **Create export**. Generation runs on the server; when
it completes, choose **Download ZIP**. Closing the dialog does not stop generation.
The ZIP contains your own and contributed library songs,
your personal playlists, and their saved song order (including moved songs and
Individual Songs). Export includes downloaded audio only, not pending downloads.
Original audio, embedded tags, lyrics and artwork are kept without transcoding.
The ZIP includes `IMPORT.txt` with import instructions. The download uses a
separate tab so large libraries do not need to be buffered in browser memory;
validation errors appear in that tab.

- **iTunes / Music:** enter the absolute local folder where you will extract the
  ZIP, such as `C:\Users\You\Music\ssMusic` or `/Users/you/Music/ssMusic`.
  Extract `Library.xml` and `Music/` directly into that folder. Add the extracted
  `Music/` folder to iTunes (Windows) or Music (macOS), then choose **File >
  Library > Import Playlist** and select `Library.xml`. The XML includes ordered
  playlists and folder relationships, with file URLs pointing to that extraction
  folder. If you move the files, export again with the new destination. Unsupported
  audio formats are rejected rather than creating unplayable iTunes entries.
- **Android:** extract the entire ZIP to one folder on the device, keeping the
  `.m3u8` playlists beside `Music/`. In a music player supporting UTF-8 M3U8
  playlists with relative paths, grant access to the folder, scan the audio and
  import the playlists. Playlist entries preserve song order; use playlist order
  rather than title/artist sorting and turn off shuffle. Android has **no universal
  library import format**: playlist import, empty playlists, names and codec
  support depend on the player. Playlist folder hierarchy is not imported.

Each user has **one latest backup**, shared by both export formats. Every successful
new export or backup replaces it, even when switching formats. A failed run keeps
the previous ZIP available. The latest backup retains its original format and
iTunes extraction destination; choose a new export to change them. Existing
downloads can finish while the next backup is created.

### Scheduled backups

In **Export library > Schedule**, enable **Scheduled backups**, choose **Daily** or
**Weekly**, a time in **UTC** (and weekday for weekly runs), and the export format.
iTunes also needs the extraction folder on your computer. Choose **Save schedule**;
**Back up now** generates a backup immediately using the displayed format settings
without starting a download. Saving a schedule does not run an immediate backup.
The dialog shows the latest archive, next scheduled run in your browser's local
time, progress, and the last backup error.

On **Jobs**, **Your library backup** shows your current or latest backup status,
refreshing every five seconds. While writing the ZIP it displays **processed / total
songs** and a progress bar. Each unique audio file counts once, even when linked
in multiple playlists; movies and playlist documents do not count. Preparation is
shown until the total is known, and completion is reported only after the archive
is saved. Completed backups retain their song total; older backups may show only
their status. Failed runs show an error and keep the previous ZIP available to download.

Schedules persist in the configured database. The running server checks due schedules once per
minute and runs one catch-up backup after downtime, not every missed interval.
Only approved accounts are processed. A failed scheduled run is retried at the
next scheduled time; use **Back up now** or **New export** for an immediate retry.
At most two users' archives are generated concurrently, with one run per user.

ZIPs are stored in `data/library-backups`. Set `LIBRARY_BACKUP_ROOT` to an absolute server directory
to override it. The client extraction folder is never used for server storage.
Docker's default location is `/app/data/library-backups`, preserved by the existing
`data` volume. An override must be on a persistent, writable mount. Keep enough
space for both the previous ZIP and its replacement during generation; superseded
files are removed after active downloads finish. Interrupted partial files are
cleaned on a subsequent backup. These are audio-library exports, not complete
server/database backups or versioned/off-site backups.

The authenticated `GET /api/library/export?source=latest` endpoint returns the
saved ZIP. `GET /api/library/export?format=android` generates a new backup and
returns it (the default source is `new`). For iTunes use `format=itunes` and a
URL-encoded `destination` parameter. The dialog uses `POST /api/library/backup`
with `{ "format": "android" }` (or iTunes plus `destination`) to start generation
asynchronously with a `202` response, and polls `GET /api/library/backup` for
`running`, `latest`, `error`, `schedule`, and `nextRunAt`. Save scheduling with
`PUT /api/library/backup/schedule`, for example
`{ "enabled": true, "frequency": "weekly", "weekday": 1, "time": "03:00", "format": "android" }`.
Weekdays are `0` (Sunday) through `6` (Saturday); `{ "enabled": false }` disables
the schedule without deleting its backup.
Status responses also include `progress` while running: `{ "stage": "archiving",
"processedSongs": 12, "totalSongs": 200, "format": "android" }`. Stages are
`preparing`, `archiving`, and `finalizing`; the total is `null` during preparation.
`progress` is `null` when idle, and newly completed `latest` records include `songCount`.
Session cookies and the existing API token authentication are supported. The
destination is only written into the XML, never used as a server output path.
Missing or unsafe audio files fail the export instead of leaving broken playlist
references; refresh the library and retry.

## Requirements

- Node.js 20+

## Setup

```bash
npm install
npm run setup:deno
npm run setup:ytdlp
npm run setup:ffmpeg
npm start
```

On Windows, `setup:deno` may print a PowerShell installation command. Run that
command before starting the server.

Copy `.env.example` to `.env`, then adjust its values for your server. `npm start`
loads `.env`, builds the React frontend, starts an HTTP redirect on `WEB_API_PORT`,
and serves the app and API over TLS on `HTTPS_WEB_PORT`.
For frontend development, run `npm run dev` while the API server is running.
Vite proxies `/api` to the configured local `HTTPS_WEB_PORT` (4000 by default).
Set `DEV_API_TARGET` to override the development API URL. Certificate verification
is relaxed only for loopback development API targets; remote targets are verified.
Passkey login still requires an origin matching the server's `PASSKEY_ORIGIN` or
`PASSKEY_ORIGIN_SECONDARY`.
To override either listener from the command line:

```bash
npm start -- --http-port 3000 --https-port 4000
```

The legacy `--port`, positional port, and standard `PORT` environment variable configure
the HTTP redirect listener. Command-line arguments take precedence over environment variables.

## Docker

Install Docker Engine with the Compose plugin, or Docker Desktop using Linux containers.
No local Node.js, Deno, yt-dlp, or FFmpeg installation is needed. The image builds the
frontend and includes Node.js 24, Deno, Linux yt-dlp, FFmpeg, and ffprobe. Linux amd64
and arm64 are supported. The app runs as a non-root user.

Docker Compose uses PostgreSQL 17. Set a unique `POSTGRES_PASSWORD` in `.env` before
starting a new installation. The database port is not published to the host.
Keep this password with your backups; changing it in `.env` does not change the
password in an already initialized PostgreSQL volume.

On PowerShell 7, the update helper generates a password when missing, builds the
image, waits for PostgreSQL, and recreates the app:

```powershell
.\update_docker.ps1
```

Use `-NoPull` to deploy the current checkout without pulling from Git. The helper
never removes volumes and stops if a build or service health check fails.

For a fresh installation with `POSTGRES_PASSWORD` already configured:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Open the configured `PASSKEY_ORIGIN`, trust the generated local certificate, and
register the first administrator passkey. The default ports are HTTP `3123` and
HTTPS `4123`; set `PASSKEY_RP_ID=localhost` and `PASSKEY_ORIGIN=https://localhost:4123`
for a localhost-only installation.
Compose publishes both ports on `127.0.0.1` by default. Stop with `docker compose down`.

Compose reads settings from `.env` if present. An existing `.env` overrides the local
passkey defaults, so ensure its hostname and origin match the URL you use. For LAN
access, configure DNS and a trusted certificate as described under **Passkey access**,
then set these values in `.env` after registering the initial administrator:

```dotenv
DOCKER_BIND_ADDRESS=0.0.0.0
WEB_API_PORT=3123
HTTPS_WEB_PORT=4123
PASSKEY_RP_ID=music.example.com
PASSKEY_ORIGIN=https://music.example.com:4123
```

Passkeys are tied to the relying-party hostname. For a deployment hostname other than
`localhost`, configure that hostname before first registration and access it locally
using DNS or a hosts-file entry while ports are still bound to loopback. Changing the
hostname later requires registering passkeys for the new hostname. When changing
`HTTPS_WEB_PORT`, also update the port in `PASSKEY_ORIGIN`. Apply configuration changes
with `docker compose up -d`.

The `postgres_data` named volume contains accounts, sessions, jobs, songs and library
organization. The `data` volume retains library backup ZIPs and TLS certificates;
`output` retains media and download archives. They
survive container recreation and `docker compose down`. **Do not use
`docker compose down -v` unless you intend to delete all stored data and downloads.**
Back up all volumes and `.env`; use `pg_dump` for a live PostgreSQL database, or stop
PostgreSQL before taking a filesystem backup of its volume. Local `data`, `output`, `.env`, and
runtime directories are not copied into the image. Container paths remain `/app/data` and `/app/output` in this
Compose configuration.

### PostgreSQL storage and limits

Songs, per-song metadata/transcription records, ownership and playlist memberships
have indexed tables. Library reads use SQL pagination (50 songs by default, maximum
100), stored counts, and a trigram search index. Metadata and ordinary transcription
updates write only the affected song row. Only the displayed page carries song
transcription details. PostgreSQL uses asynchronous pooled connections;
`DATABASE_POOL_SIZE` defaults to 10.

Large organization edits and inventory changes still rebuild the affected user's
materialized library catalog, and the legacy Jobs dashboard/export paths can load
complete jobs. Legacy playlist requests without paging parameters still return
the complete selection for client compatibility. Deep numbered pages use SQL offsets. These operations need load
testing before promising a particular million-song latency. Run one app instance:
download, import, file and backup locks are still process-local. Mutation transactions
use a PostgreSQL advisory lock to preserve the existing atomic update semantics.
### Tests

Run `npm test` with Docker available. The test runner starts a disposable PostgreSQL
17 container, runs the suite, and removes the container afterward. Each database-backed
fixture gets its own temporary database; no deployed database or volume is used.
To select tests, use `npm test -- test/database.test.js test/postgres.test.js`.

Alternatively, provide a dedicated PostgreSQL test service with a database named
`ssmusic_test` and a user allowed to create and drop databases:

```powershell
$env:TEST_POSTGRES_URL = 'postgres://user:password@127.0.0.1:5432/ssmusic_test'
npm test
```

Set `TEST_POSTGRES_SCALE=1` to also populate and remove a synthetic million-song
catalog and report first-page, search, and deep-page timings. This checks database
queries, not a million physical audio files or simultaneous playback clients.
Do not point test configuration at production. Direct `node --test` runs require
`TEST_POSTGRES_URL`; `npm test` provisions it automatically when omitted.

For your own TLS certificate, add a read-only bind mount such as
`./certs:/app/certs:ro` to the app's `volumes` in `compose.yaml`, then set
`HTTPS_KEY_PATH=/app/certs/server-key.pem` and
`HTTPS_CERT_PATH=/app/certs/server-cert.pem` in `.env`. The files must be readable
by the container's `node` user (UID 1000). Host paths cannot be used directly.

For a transcription service running on the Docker host, use
`TRANSCRIPTION_ENDPOINT=http://host.docker.internal:4317/api/transcribe` in `.env`.
Inside the container, `localhost` refers to the container itself. On Linux, the host
service must listen on an interface reachable from Docker, with firewall access allowed.
For another Compose service, use its service name instead of `localhost`.

The container health check probes HTTPS with local certificate verification disabled
only for that probe. Daily yt-dlp and Deno self-updates remain enabled; runtime binaries
are writable by the app user. Those updates last until the container is recreated.
To refresh the base image, npm dependencies from the lockfile, and bundled runtimes:

```bash
docker compose build --pull --no-cache
docker compose up -d
```

## Passkey access

The app and operational APIs require passkey authentication. On a new server, register
the first passkey to create the initial approved administrator. Later registrations are
saved as pending and cannot log in until an administrator approves them from **Admin**.
Administrators can approve or revoke access and assign User, Admin, or Shared roles.
During registration, select **Register as a Shared user** and choose an **Organizer**
from the approved User and Admin accounts. Shared registrations still require admin
approval; choosing an organizer does not automatically grant any libraries. The
registration picker exposes only eligible users' IDs and display names.

Approved User and Admin accounts can send, accept, decline, cancel, or remove link
requests from **User settings > Linked users**. Both users must consent before their
libraries become visible to each other. Accepted links provide read-only library
access, not ownership or contributor permissions, and do not include other users'
links. Use the **Library** dropdown on the Music page to switch between your own
library and accepted linked libraries. Your own library remains editable.

Organizers manage assigned accounts from **User settings > Shared users**. Select a
Shared user, check the libraries they may read, and choose **Save access**. Choices
are the organizer's own library and their accepted linked users' libraries. An
organizer cannot change account approval, credentials, roles, or another organizer's
Shared users. Pending accounts can be configured but cannot log in before approval.
Admins can change the organizer directly in a Shared user's row under **Admin > All users**
or from that user's details. Select the **Organizer** dropdown and confirm the change;
reassignment clears existing library grants. **Administrator managed** retains the previous
admin-only grant workflow, allowing any approved User or Admin library.

Shared users can switch between their granted
libraries, browse playlists, play media, read lyrics, view song metadata, and download individual songs.
Shared users can see their granted library owners under **User settings > Library access**.
They cannot access health metrics or run health polling. They can change their own
username, color theme, and light/dark appearance. They cannot change
libraries, jobs, metadata, ratings, other users' preferences, credentials,
or access grants, create exports/backups, or browse the Jobs dashboard. Login and
logout remain available. Restrictions apply to cookies, bearer sessions, and PATs.
No grants means no library access. Removing a grant immediately blocks subsequent
requests for its songs; already downloaded media cannot be recalled. Changing away
from Shared clears the account's grants. Revoking, deleting, or changing a library
owner to Shared removes grants to that owner's library.
Removing a user link also removes any dependent grants to Shared accounts managed by
either user. Revoking, deleting, or converting an organizer to Shared removes their
links and delegated grants and clears their organizer assignments; reapproval or
relinking does not restore old grants.

Link and organizer management require a passkey session (cookie or Bearer), not a PAT:
- `GET /api/auth/links` lists links, incoming/outgoing requests, and eligible users.
- `POST /api/auth/links` accepts `{ "userId": "..." }` to request a link.
- `POST /api/auth/links/:id/accept` accepts an incoming request from that user.
- `DELETE /api/auth/links/:id` declines, cancels, or removes a link.
- `GET /api/auth/shared-users` lists the organizer's Shared accounts and eligible libraries.
- `PUT /api/auth/shared-users/:id/libraries` accepts `{ "sharedUserIds": ["..."] }`;
    an empty array removes all grants.

`GET /api/auth/register/users` supplies the registration organizer picker.
`POST /api/auth/register/options` accepts optional `role` (`user` or `shared`) and
`organizerId` fields with the name. Shared registrations require an organizer; the
choice is bound to the single-use passkey challenge and revalidated at verification.

Users can rename themselves in **User settings > Username**. Administrators can
rename accounts in **Admin > User details > Username**. Names must be 2-64 characters
and unique without regard to case; surrounding and repeated whitespace is normalized.
Renaming preserves account IDs, passkeys, sessions, and library access. Self-service
renaming requires a passkey session, not a PAT, and cannot change roles or grants.
Use the trash button under **Admin > All users** to permanently delete an account
after confirmation. Deletion removes registered passkeys, sessions, PATs, preferences,
and personal library layout, but preserves backup records, saved backup ZIPs, jobs,
and downloaded media. Retained backups remain associated with the deleted user's ID;
scheduled runs stop, and they are no longer accessible through that account in the app.
Registering the same name again does not inherit those backups. Existing databases
are migrated automatically on startup to retain backups when an account is deleted.
Administrators cannot delete themselves or the last approved administrator.
`DELETE /api/admin/users/:id` requires an administrator passkey session (cookie or
Bearer), not PAT-only authentication. It returns `204` on success, `404` for an
unknown user, or `409` for a protected account.
Complete the first registration locally before exposing a new server to other users,
because the first verified passkey is intentionally trusted as the initial administrator.

Approved users and administrators can add more passkeys from **User settings > Passkeys >
Add passkey** while signed in. Each new passkey belongs to the existing account, keeping
the same approval, permissions, and library; existing passkeys continue to work. Repeat
with another device, password manager, or security key as needed. Enrollment uses the
current hostname's RP ID and does not link accounts on unrelated hostnames.

The **Passkeys** section lists every registered credential with its ID and reported
transports, creation date, and last-used date in your local time. Creation is recorded
at enrollment; last use updates after verified passkey authentication for an approved
account, not when an existing session or PAT is used. New keys show **Never** until
their first sign-in. Dates not recorded for older keys show **Unknown**; their next
successful sign-in records last use. Existing databases are upgraded automatically.
Use a passkey's trash button and confirm to remove it from the account.
At least one passkey must remain. Removed passkeys cannot log in again; existing
sessions remain signed in. Removal does not erase the saved key from your device
or password manager.

Passkey management requires a passkey session, not a PAT:

- `GET /api/auth/passkeys` returns `{ "user": {...}, "passkeys": [...] }` for the
    signed-in account. Passkey entries contain `id`, `transports`, `createdAt`, and
    `lastUsedAt`. Dates are UTC ISO timestamps or `null` when not recorded.
- `DELETE /api/auth/passkeys/:credentialId` removes one of your passkeys and returns
    the updated user and passkey list. Unknown or other users' credentials return
    `404`; removing your last passkey returns `409`.
- `POST /api/auth/passkeys/options` returns registration options for the signed-in account,
    reusing its user handle and excluding its existing credentials.
- `POST /api/auth/passkeys/verify` accepts `{ "requestId": "...", "response": {...} }` and
    returns the updated user and passkey list with `201`. Requests are single-use, expire
    after five minutes, and are bound to the account, origin, and RP ID. Duplicate
    credentials are rejected.

Passkeys work on `localhost` without TLS, but other hosts require HTTPS. The server creates
`data/tls/server-key.pem` and `data/tls/server-cert.pem` when certificate paths are omitted.
Trust the generated certificate on each client before opening the app, or configure a trusted
certificate with `HTTPS_KEY_PATH` and `HTTPS_CERT_PATH`.

The passkey origin must include `HTTPS_WEB_PORT` when it is not the default port 443:

```bash
WEB_API_PORT=3123
HTTPS_WEB_PORT=4123
PASSKEY_RP_ID=music.example.com
PASSKEY_ORIGIN=https://music.example.com:4000
npm start
```

Do not use a raw IP address for `PASSKEY_RP_ID`; passkey clients require a domain-shaped
relying-party ID. For LAN-only use, configure a hostname in local DNS, or use a resolving
hostname such as `192-168-1-123.sslip.io` for the server at `192.168.1.123`:

```bash
PASSKEY_RP_ID=192-168-1-123.sslip.io
PASSKEY_ORIGIN=https://192-168-1-123.sslip.io:4000
```

To keep a public hostname and also allow local-browser passkeys, configure both
secondary settings alongside the primary settings:

```dotenv
PASSKEY_RP_ID_SECONDARY=192-168-6-66.sslip.io
PASSKEY_ORIGIN_SECONDARY=https://192-168-6-66.sslip.io:4123
```

Open the exact secondary HTTPS URL, including its port. Registration and login select
the secondary RP ID only when the browser origin matches `PASSKEY_ORIGIN_SECONDARY`;
other requests retain the primary configuration. Each challenge remains bound to the
selected origin and RP ID. Both secondary settings must be provided together, and
the RP ID must be a hostname, not a raw IP address.

Rebuild/recreate the Docker container after changing these settings (for example,
`docker compose up -d --build`). Generated local certificates cover both configured
RP IDs and origin hostnames, using the secondary hostname as their common name when
configured. An older generated certificate is replaced if needed; trust the replacement
on each client before using passkeys. Custom certificates are not changed and must
already cover the local hostname.

Passkeys are scoped to their RP ID: an existing public-hostname passkey cannot be used
on an unrelated local hostname. Register a local passkey with a different account name
and have an administrator approve that account. This does not link the two accounts.
To use the existing account and passkey locally, keep the public HTTPS hostname and
resolve it to the server's LAN address using local DNS, with a trusted certificate.

Users, public passkey credentials, access decisions, and hashed login sessions are stored
in PostgreSQL alongside job history (see **Database storage** below). Private passkey keys
remain in the user's authenticator, such as Bitwarden, and are never sent to the server.

Passkey registration and login endpoints have stricter per-client rate limits than the
authenticated API. WebAuthn challenge storage is bounded and expired challenges are removed,
JSON request bodies are size-limited, and both listeners enforce connection and request
timeouts. Set `MAX_CONNECTIONS` to adjust each listener's simultaneous connection ceiling.
For an internet-facing deployment, retain these application controls behind a reverse proxy
or managed DDoS service; one Node.js process cannot absorb a volumetric network attack alone.
When a trusted reverse proxy is the only route to the app, set `TRUST_PROXY` to its hop count
or subnet so per-client limits use the forwarded address. Do not enable it when clients can
connect directly, because untrusted forwarding headers can be spoofed.

By default, the server expects Deno at `runtime/deno/bin/deno`.
You can override this with `DENO_PATH=/absolute/path/to/deno`.
It expects yt-dlp at `runtime/yt-dlp/yt-dlp.exe`; override this with
`YTDLP_PATH=/absolute/path/to/yt-dlp`.
FFmpeg and ffprobe are loaded from `runtime/ffmpeg/bin`; override this with
`FFMPEG_PATH=/absolute/path/to/ffmpeg/bin`.

## Android app integration

Android uses browser-based passkey login in a Chrome Custom Tab (or the system
browser), followed by a single-use authorization code exchange with S256 PKCE.
It uses the same account and passkey as the web UI, without a PAT, Google Play,
Digital Asset Links, app ID configuration, or signing-certificate fingerprints.
The previous native Credential Manager flow (`client: "android"`) is no longer
supported. `ANDROID_APP_ID` and `ANDROID_SHA256_CERT_FINGERPRINTS` can be removed
from existing environments; they are no longer read or passed through Compose.
The generated `/.well-known/assetlinks.json` endpoint has been removed.

Keep `PASSKEY_RP_ID` and `PASSKEY_ORIGIN` identical to your existing web login.
Open the browser login URL at that exact origin, including any port. Your phone
must resolve/reach the hostname and trust its HTTPS certificate in both the
browser and the app. Do not disable TLS validation. This flow does not require
standard port 443 or public domain-association hosting. Sideloaded/debug APKs
work with the same protocol; the passkey must be available in the browser's
credential provider. Use an external browser, not an embedded WebView.

### Login contract

1. Generate independent cryptographically random `codeVerifier` and `state`
   values for each login (32 random bytes each, base64url without padding).
   Retain them together with the chosen server origin in private app storage
   until the login finishes. Never send the verifier to the browser.
2. Compute `codeChallenge = BASE64URL(SHA256(ASCII(codeVerifier)))`, without
   padding. Open the following URL with correctly URL-encoded query values:

   ```text
    <PASSKEY_ORIGIN>/app-login?redirect_uri=com.ssmusic.app%3A%2Foauth%2Fcallback&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=<STATE>
   ```

3. The user selects **Authorize with Passkey** and completes a fresh browser
   passkey confirmation, even if a browser session already exists. The page
    returns to `com.ssmusic.app:/oauth/callback?code=<CODE>&state=<STATE>` and
   offers **Return to app** if automatic navigation is blocked. Cancel leaves
   the authorization page without issuing a code; closing the tab cancels too.
4. In the Android callback, require the exact scheme/path and expected `state`;
   reject unsolicited callbacks, mismatches, duplicate parameters, or an already
   completed login. Exchange only at the server origin saved in step 1, never
   an origin supplied by the callback. Send `POST /api/auth/app/token` with JSON:

   ```json
   {
     "code": "CODE_FROM_CALLBACK",
     "codeVerifier": "ORIGINAL_SECRET_VERIFIER",
    "redirectUri": "com.ssmusic.app:/oauth/callback"
   }
   ```

   The response is `{ "user": { ... }, "session": { "token": "...",
   "tokenType": "Bearer", "expiresAt": "..." } }`. No cookie or existing
   login is required for this exchange; a correct code and verifier are required.
   Delete the temporary verifier/state after completion or cancellation.
5. Send `Authorization: Bearer <session.token>` on authenticated requests.
   Store the session using Android Keystore-backed storage, never URLs/logs.
   Sessions last 30 days without sliding expiry or refresh tokens and survive
   server restarts. On expiry or `401`, start a new browser login.

Register an exported callback Activity with a browsable `VIEW` intent filter
for scheme `com.ssmusic.app`. The callback is a private-use URI with no host;
validate the complete URI path `/oauth/callback` in the Activity. The server
also accepts the legacy `com.ssytdlp.app:/oauth/callback` URI so installed clients
keep working. Each authorization code is bound to the exact URI requested;
the schemes cannot be swapped during token exchange. Arbitrary redirects are rejected.

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.ssmusic.app" />
</intent-filter>
```

Private-use schemes do not prove an app's identity: another installed app can
claim the scheme. PKCE prevents an interceptor redeeming a code without the
original verifier. Only authorize login requests you initiated from your app.

The browser page calls `POST /api/auth/login/options` with `client: "browser-app"`,
`redirectUri`, `codeChallenge`, `codeChallengeMethod: "S256"`, and `state`.
It then calls `/api/auth/login/verify` with `requestId` and the WebAuthn `response`.
That response contains only `redirectUrl`, never a bearer token. State must be
43-128 base64url characters; the verifier must be 43-128 RFC 7636 unreserved
characters. The callback and PKCE challenge are bound to the WebAuthn challenge;
changing them at verification cannot redirect or replace the authorization.

Passkey challenges expire after five minutes; authorization codes expire after
60 seconds and are consumed on the first exchange attempt, including invalid
attempts. Both are in memory, bounded, rate-limited, and cleared on restart.
An expired/used code or wrong verifier returns `400`; restart the login flow.
Account changes before exchange return `403` and require a fresh login.
Pending/revoked accounts cannot authorize; passkey verification returns `403`
with `ACCESS_PENDING` or `ACCESS_REVOKED`. Rate limiting returns `429`.

Normal web login remains cookie-based and now issues `ssmusic_session` cookies.
Existing `ssytdlp_session` cookies remain accepted until expiry or logout;
browser logout revokes and clears both names. Bearer sessions and PATs are unchanged.
The app flow neither reads nor replaces
the browser session. `GET /api/auth/me` returns the bearer session's user;
`POST /api/auth/logout` with that bearer header revokes only that session (`204`).
Account revocation invalidates all sessions. Send only one auth mechanism:
invalid Authorization headers do not fall back to cookies, `X-PAT` retains
precedence on general API routes, and PATs are not bearer sessions.
Register new accounts in the regular web UI and wait for approval before app login.

### Feature endpoints

Bearer sessions work with all existing `/api/jobs`, `/api/library`,
`/api/preferences`, `/api/health`, and authorized `/api/admin` routes, as well as
passkey-session-only PAT management. Existing owner/contributor/admin rules apply.
Use the library, metadata, transcription, and job API contracts documented below.
Both clients share server-side library layouts and preferences; on a library `409`
conflict, fetch the latest version before retrying the user's edit.

File listings and library tracks return relative `streamUrl` and `downloadUrl`
values. Resolve these against the server base URL and attach the bearer header to
media/download requests too. Configure the Android Media3/ExoPlayer HTTP data
source to send this header, including byte-range requests for seeking (`206`
responses). `/api/jobs/:id/lyrics/:name` supplies lyrics and artwork metadata.
Do not forward credentials when following redirects to another host. Native HTTP
clients do not need CORS changes; passkeys run in the external browser and
authenticated feature requests use native networking.

## Usage

- Open the HTTPS URL configured by `PASSKEY_ORIGIN` to use **ssMusic Player** at `/`.
- Select **Jobs** or **Add music** to open the download dashboard at `/job`.
- Paste a `https://music.youtube.com/...` URL.
- Submitting the same source URL (ignoring surrounding whitespace) prompts to rerun
    the most recent matching job. Confirming keeps its downloaded files and opens its
    details under the same job ID; cancelling leaves it unchanged. Active matches can
    be opened but cannot be rerun until they finish.
- Any music URL with a `list` query parameter (including `/playlist?list=...` and `/watch?v=...&list=...`) runs with `--yes-playlist`
- Any other music URL runs with `--no-playlist`
- Open a finished job's details to view its command, rerun it under the same job ID,
  or delete the job and its downloaded files
- Use the trash button beside a song in job details to delete that individual file.
    Confirming updates the file list and ZIP contents; other songs are kept.

On **Jobs**, choose **Select jobs** beside **Recent jobs** to select several rows.
The select-all checkbox selects jobs matching the current user filter. Sorting and
automatic refreshes preserve selection; changing the filter or leaving selection
mode clears it. Use **Rerun selected jobs** or **Delete selected jobs**, then confirm.
Every selected job must permit the action: active jobs cannot be changed, imported
jobs cannot be rerun, and deletion requires ownership or administrator access.
Actions run one at a time with progress shown, without leaving the list. Successful
jobs are deselected; failed jobs remain selected with individual errors for retry.
Bulk deletion permanently removes the jobs and their downloaded files, including
files used by linked playlists. A failure does not undo earlier successful actions.

Approved users can view and download all jobs. Job owners can rerun their jobs,
delete songs, delete the job, and manage its contributors. In job details, use
**Manage contributors** beside **Contributors**, select approved users, and save.
Uncheck a user and save to remove their contributor access. Contributors can rerun
that job and delete individual songs, but cannot delete the job or manage contributors.
Contributor access is per job, not an account role.

Administrators retain full control over every job, including contributor management
and older jobs without a recorded owner. The original initiating user remains the
owner after any rerun. Permissions also apply to PAT requests. Queued/running jobs
cannot be modified, including their contributors, even by administrators.

The dashboard defaults to **My jobs (owned and contributing)** for every user,
including administrators. **All users** and individual initiator filters remain
available. Existing jobs start with no contributors; assignments are persisted in PostgreSQL.

New playlist jobs use a title-and-job-ID folder name to avoid sharing files between
jobs with the same playlist title. Existing folders are preserved. If an older folder
is shared by multiple jobs, non-admin users need permission for the requested action
on every job sharing the folder.

Jobs are persisted in PostgreSQL and restored after server restarts. Jobs show
queued/running/completed/partially completed/failed status; any active job interrupted by a restart
is restored as failed so it can be rerun safely.
Private or unavailable videos skipped by yt-dlp produce a partially completed job rather than a failed job.
Downloaded files are written under `./output/<job-folder>/` and can be downloaded from the job details page.
Use **Download all** on a job with files to download its songs as a ZIP archive.
Job details include the command and complete captured stdout and stderr output.
New jobs automatically fetch their YouTube playlist or video title before downloading
and record it as a separate `playlistTitle`, preserving spaces, punctuation, and
non-ASCII characters. Job creation does not wait for this lookup. If the lookup fails
or returns no title, downloads continue and the title falls back to the folder or
downloaded song name. Single-track jobs keep their random output folders.
The job list, details, music library, and ZIP name use this title.
Existing jobs receive readable titles derived from their folder or song names;
their output folders and download archives are not renamed or moved.
Owners and administrators can use the pencil beside **Playlist Title** in job
details to rename an idle job, or use the pencil beside a playlist in the Music
sidebar without selecting it. **Edit playlist** groups the name, **Make private**,
**Location**, **Open job details**, and **Share Playlist** controls. Row pencils are
available outside reorder mode. Privacy remains owner-only, and linked playlists
can be moved within your own library without granting permission to rename them.
On mobile, editing keeps the Playlists view open. Save changes or cancel to leave
the pending edits unchanged. Contributors cannot rename playlists, and the permanent
**Individual Songs** playlist cannot be renamed. Custom titles
survive reruns and never rename output directories. The API is
`PATCH /api/jobs/:id/title` with `{ "playlistTitle": "My favorites" }`;
titles must contain 1-200 characters without control characters.

Reruns reuse the original output folder and pass `--no-overwrites` and
`--download-archive` to yt-dlp. Successfully downloaded video IDs are recorded in
`.download-archive.txt` inside that folder and skipped on subsequent runs; failed
downloads can be retried. The archive is excluded from the song list and ZIP downloads.
Songs removed from a playlist remain on disk. Downloads made before archive tracking
rely on existing filenames for protection until recorded in the archive. Keep the
archive with its songs: manually deleting a song does not remove its archive entry,
so yt-dlp will still skip it. Deleting a job still removes its folder and archive.
Deleting an individual song through the app also retains its archive entry, so tracked
songs stay skipped on reruns. Older songs not yet tracked may download again.

To remove an individual file via the API, send
`DELETE /api/jobs/:id/files/:name` with the URL-encoded filename. This returns the
updated job, or `403` for insufficient permissions, `404` for an unknown job or song,
and `409` when the job is active or another modification is in progress.

Owners and administrators can manage contributors with:

- `GET /api/jobs/:id/contributors/users`: available approved users, with IDs and names only.
- `PUT /api/jobs/:id/contributors` with `{ "userIds": ["USER_ID"] }`: replace the
    contributor list and return the updated job. Send an empty array to remove all
    contributors. Unknown, pending, revoked, and owner IDs are rejected with `400`;
    insufficient permissions return `403`, missing jobs return `404`, and active or
    busy jobs return `409`.

## Personal music library

The main page (`/`) is titled **{USERNAME}'s Music**, including the browser tab.
It lists only jobs you initiated or contribute to, using their **Playlist Title**.
This personal-library rule also applies to administrators. The Jobs dashboard keeps
its existing broader access rules. Select a playlist on the left to browse its songs
on the right. Search playlists or songs independently.
Song rows lazy-load **96 × 96 WebP thumbnails** of embedded MP3 album artwork,
with a music-note placeholder when no supported cover is available. Uploads,
downloads, metadata edits, file replacement, and transcription refresh the
thumbnails using the existing FFmpeg runtime. Original artwork and audio are
unchanged.

Thumbnails are cached on disk under `data/artwork-thumbnails` (the existing Docker
data volume), not in PostgreSQL. Unchanged songs are served from this cache without
reading their ID3 tags again. Source-file revisions invalidate stale thumbnails,
including when artwork is removed; older cached revisions are discarded. Existing
songs without a cache are generated on their first artwork request. A thumbnail
generation failure does not roll back a song upload or edit; check FFmpeg and retry.
Artwork requests still require authentication and granted-library access.

On **Admin → Users**, use **Regenerate all thumbnails** in the album artwork section to
rebuild thumbnails for all indexed MP3 songs, across all users. Regeneration runs in
the background in bounded batches, with processed, generated, missing, and failed
counts. Only administrators may start or view this operation, and only one rebuild
runs at a time. Individual failures do not stop the remaining songs. Progress is
in memory and resets on server restart; cached images persist. Restart regeneration
after a restart or after correcting FFmpeg errors. The original images remain
available in song metadata and downloads.

The playback dock supports play/pause, previous/next, shuffle, repeat, seeking,
volume, a playback queue, embedded artwork, and synchronized or plain-text lyrics.
Lyrics open over a darkened page while the playback dock remains visible and
interactive. Close lyrics with the close button, the backdrop, or Escape.
Browsing another playlist or folder does not interrupt the playing queue.
The same dock and audio element stay active when navigating to Jobs, job details,
the job player, Health, Admin, or Settings, including browser Back/Forward.
Logging out stops playback. Reloading the browser or opening another tab starts a
new player session; playback is not transferred between tabs.
On narrow screens, switch between **Playlists** and **Songs**; volume controls are hidden.

**Add Playlist** opens a URL dialog for a YouTube Music playlist or individual
song. It uses the same validation, duplicate confirmation, and permitted reruns
as **Add job** on `/job`, without leaving the music library. Cancelling a duplicate
confirmation does not rerun or link it.
An existing URL owned by someone else cannot be added until its owner makes you a contributor.

The first individual-song link creates a permanent **Individual Songs** playlist
for that user. Later individual links share this playlist instead of creating
one library entry per song. It stays available when empty and cannot be deleted,
even if all its source jobs are removed. Contributors can link an existing
individual job to their own independent collection. Removing contributor access
removes that job's songs from their library.

Single-item jobs using **Video only** go to a separate permanent **Individual
Videos** playlist. Audio-only singles continue to use **Individual Songs**;
full video playlists keep their own playlist entries.

Use **New playlist folder** to create a folder. A selected folder becomes the
default location for new subfolders. Folders support nesting up to 32 levels.
Open the pencil beside a playlist or folder to edit it. The dialog's **Location**
menu moves it to any valid folder or back to the library root; folder dialogs exclude
the folder itself and its descendants. Drag a playlist onto the center of a folder to move it inside,
or onto the upper/lower half of another playlist to place it before/after that
playlist. **Edit folder** also includes **Delete folder**, with confirmation;
deleting a folder moves its immediate contents to its parent without deleting any music.
These controls no longer occupy a separate organize section beneath the playlist tree.

Use **Select playlists** beside the Playlists heading to select several playlists,
then **Move selected playlists to folder** to move them together to a folder or
the library root. The select-all checkbox applies to matching playlists, including
those inside collapsed folders. The operation preserves their saved relative order.

Use **Collapse all folders** beside the Playlists heading to close every folder,
including nested folders; the button then becomes **Expand all folders**.
Playlist selections are preserved. The control is disabled during playlist search,
which automatically opens folders containing matches, or when there are no folders.

In **New playlist folder**, use **Add folder** to enter multiple folder names,
choose their shared **Location**, then select **Save folders**. Extra rows can
be removed before saving. All folders are created together; validation errors
leave the library unchanged and keep the entered names available to correct.

Folder creation, editing, deletion, and playlist/folder moves use compact,
version-checked actions at `POST /api/library/entries`: `create-folder`,
`create-folders`, `update-folder`, `delete-folder`, and `move`. Batch creation
accepts `folders: [{ id, name }]` and a shared `parentId`. Requests contain the
affected IDs and changed fields, not the library's entries or song orders. Song moves,
reorders, playlist linking and bulk additions also use targeted requests. The
legacy full-replacement `PUT /api/library` remains available with its existing
128 KB limit; the frontend no longer uses it for organizing the library.

Select **Reorder playlists** beside the Playlists heading to show drag grips
on every playlist and folder, including **Individual Songs**. Drag a row by its
grip or name to the insertion line above or below another row. In reorder mode,
dropping on a folder places the item beside it rather than inside it. Each move
saves automatically for your account. Moving a folder keeps its contents together.
On mobile, press and hold a grip or name, then drag; the Playlists view stays open.
Keyboard users can focus a grip and press Arrow Up or Arrow Down to reorder siblings.
Search is temporarily disabled and all entries are shown while reordering; toggle
**Reorder playlists** off to restore the normal list and search.

A selected folder plays all descendant playlists in their saved tree order, then
each playlist's songs in its saved song order. Drag a song within its playlist
to reorder it, including when browsing a folder. Job
details and the existing `/job/:id/player` view show the same saved song order.
Song reordering sends a compact, version-checked move to
`POST /api/library/songs/reorder` instead of uploading the whole library, so large
imported playlists do not exceed the JSON request-size limit.
New playlists appear at the library root; new songs append after saved song
positions. Deleted jobs and files are removed from the saved layout automatically.

On phones and tablets, press and hold a song's grip or a playlist/folder grip or name
for a moment, then drag to organize it. Valid drop targets are highlighted, and
dragging near the edge scrolls the list. Swipe normally to scroll without
reordering. On narrow screens, use **Move to playlist** to move songs between
the separate Songs and Playlists views. Touch controls have larger hit targets;
tap or drag the seek bar to change playback position. Use the device's volume
buttons for volume on touch devices.

Song rows offer the same transcription dialog, status, and delete confirmation as
job details. These actions use the source job's owner/contributor permissions and
busy state, including for moved songs. Removing a song in the library removes only
that playlist membership. Its source file stays intact while another playlist
link exists, including in another owner's or contributor's library. Removing the
last link deletes the source file; download archives remain unchanged. Direct
file deletion from job details returns `409` while multiple links exist; remove
the unwanted memberships from the library first. Whole-job deletion remains a
separate destructive operation.

Inside a playlist, use **Select songs**, select the songs, then **Move selected
songs** or **Link selected songs** and choose a destination playlist. Move removes
only the selected source memberships; link retains them. Existing destination
memberships are not duplicated, and new memberships append in source playlist
order. Select-all applies to songs matching the current search, including the
NoVocals group. Selection is cleared when switching playlists or after a successful
bulk operation; failed saves retain the selection for retry. These controls also
work in the mobile Songs and Playlists views.

Use a song's **Move to playlist** button, or drag it onto a playlist in the
sidebar, to move it between playlists. Songs cannot be placed directly in
playlist folders. Moves belong to your account; source audio, download archives,
job file lists, and other users' memberships stay intact. Songs retain their
source job ID, so identical filenames from different jobs remain distinct and
playable. If a destination job is deleted, surviving songs return to their
original playlist or Individual Songs. Reordering also updates the corresponding
source-job song order shown in job details.

Themes, folders, playlist order, and song order belong to the signed-in account
and persist in PostgreSQL across browsers and server restarts. Organizing your library
does not change anyone else's layout or grant additional job-management access.
Choose the palette icon in the account bar or **User settings > Appearance** for
Midnight blue, Royal purple, Gold, Green, Pink, or Black. Every color
has **Light** and **Dark** counterparts. Color and mode are saved separately;
changing color keeps the chosen mode. Existing Black and Midnight blue users
retain dark mode on upgrade; the other existing themes retain light mode.
New accounts default to Midnight blue in light mode. The retired Porcelain palette
falls back to Midnight blue while preserving light/dark mode; other saved colors
remain unchanged.

Authenticated library APIs (sessions and PATs):

- `GET /api/preferences` and `PUT /api/preferences` with `{ "theme": "royal-purple", "mode": "dark" }`.
    Theme IDs are `midnight`, `royal-purple`, `gold`, `green`, `pink`, and `black`.
    The legacy palette ID `light` is accepted as an alias for `midnight`.
    Either field can be updated independently; mode is `light` or `dark`.
- `GET /api/library`: returns `version`, `entries`, `songOrder`, `playlistSongOrder`,
    `songMoves`, `songAdds`, server-managed `songRemovals`, `singleJobIds`, visible
    `playlists`, and source `jobs` summaries.
- `PUT /api/library`: saves `version`, `entries`, and `songOrder`. Playlist entries
    have `{ "id": "JOB_ID", "type": "playlist", "parentId": null }`; folder entries
    add `"name"` and use a unique `folder-`-prefixed ID. A `parentId` references a folder.
    Entries are ordered among siblings. `songOrder` maps job IDs to filename arrays.
    `playlistSongOrder` maps playlist IDs to ordered track keys, each key being
    `JSON.stringify([jobId, filename])`. `songMoves` contains `{ jobId, name, playlistId }`
    overrides. Omitted membership fields are preserved. `singleJobIds` is server-managed;
    omitting the protected `individual-songs` entry cannot delete the collection.
    Stale versions return `409`, so simultaneous tabs cannot silently overwrite changes.
- `POST /api/library/links` with `{ "jobId": "JOB_ID" }`: link an existing job,
    creating or updating Individual Songs for individual jobs. Normal `/api/jobs`
    submission also registers individual links automatically. Only owners and
    contributors can link a job; unrelated accounts receive `403`.
- `POST /api/library/songs/move` with `{ "version": 1, "jobId": "SOURCE_JOB_ID", "name": "song.mp3", "playlistId": "DESTINATION_ID" }`:
    move a song to a playlist, appending it after that playlist's current songs.
    Folder and unavailable destinations are rejected; stale versions return `409`.
- `POST /api/library/playlists/move` with `{ "version": 1, "ids": ["PLAYLIST_A", "PLAYLIST_B"], "parentId": "folder-example" }`:
    atomically move selected playlists into a folder; use `null` for the library root.
- `POST /api/library/songs/transfer` with `{ "version": 1, "action": "link", "sourcePlaylistId": "SOURCE", "playlistId": "DESTINATION", "keys": ["[\"JOB_ID\",\"song.mp3\"]"] }`:
    atomically link or move selected songs. Set `action` to `move` to remove source
    memberships. Keys are `JSON.stringify([jobId, filename])`, not row indexes.
    Both bulk endpoints accept at most 5,000 unique identities with a scoped 3 MB
    request limit, validate the entire selection, and reject stale versions with
    `409`. They never require a full library snapshot.
- `POST /api/library/songs/remove` with `{ "version": 1, "jobId": "JOB_ID", "name": "song.mp3", "playlistId": "PLAYLIST_ID" }`:
    remove one membership, deleting the physical file only for the last link.
    Returns the updated library and `fileDeleted`. Owner/contributor file permissions,
    busy checks, and version checks apply. Failed file deletion retains the last link.
- `GET /api/library/tracks?entryId=ENTRY_ID`: returns ordered playable files for a
    playlist or folder, including each file's source `jobId`, current `playlistId`, and `playlistTitle`. Omit
    `entryId` to retrieve all music in library order.

## Song metadata and artwork

The pencil beside an MP3 song opens **Edit song metadata** in the library or job
details. Edit title, artist, album, album artist, genre, year, track number, and disc
number. Choose or remove artwork; uploads must be JPEG, PNG, or WebP, at most 2 MB.
MP3 ratings appear as zero to five stars in playlist songs and job files. Choose
stars or **No rating** in the same editor to update the file's ID3 `POPM` tag.
The existing rating owner and play count are retained. Ratings are read from the
song file, not the separate iTunes XML database. Job details, process output, and
files are stacked full-width; song files also show artist and album metadata.
Other audio formats offer the transcription lock control, but not MP3 tag editing.

Shared users can choose **View song metadata** (the info icon) on songs in their
granted libraries. The dialog shows metadata, artwork, rating, and transcription
lock status read-only, with no save, artwork, rating, or lock editing controls.

Edits update the source MP3, including for personally moved songs, and therefore
are visible to everyone using that source. Filenames, audio data, embedded lyrics,
and download archives are preserved. The playing dock's text and artwork update
without restarting the audio. Owners, contributors, and administrators can edit
idle jobs; active downloads and conflicting file mutations return `409`.
Transcribing a song blocks editing that song, not other songs in the same job.
The lock icon in the editor toggles transcription locking when changes are saved.

`PATCH /api/jobs/:id/files/:name/metadata` accepts a JSON object with any of
`title`, `artist`, `album`, `performerInfo` (album artist), `genre`, `year`,
`trackNumber`, and `partOfSet` (disc number). Text fields are limited to 500
characters. Include `artwork` as a base64 image data URL to replace it, `null` to
remove it, or omit it to preserve the current cover. The response contains the
updated song metadata, including `rating`. Include integer `rating` from `0`
(unrated) to `5`, or omit it to retain the original rating. Both job-file and
library-track responses include MP3 ratings. URL-encode the full filename,
including `[NoVocals]/`.

Include boolean `transcriptionLocked` to lock or unlock transcription. Lock-only
updates work for all supported audio formats and do not require the transcription
service. Locked songs keep the microphone action but offer only **Generate NoVocals
Only**. Normal transcription still returns `409`; manual metadata and lyrics editing
remain available.

MP3 lyrics can be updated through the same endpoint: `uslt` is plain text, and
`sylt` is an array of `{ "time": 1.25, "text": "Lyric line" }` with times in seconds.
Each format is limited to 100,000 characters; SYLT accepts at most 10,000 lines
with nonnegative timestamps up to 4294967.295 seconds (ID3's millisecond range).
Omitted formats are preserved; `uslt: ""` or `sylt: []` clears that format.

## Replace a song file

Choose **Replace File** from a song's actions in the library or job details.
Select one non-empty audio file in the **same format** as the current song
(up to 512 MB), then confirm with **Replace File**. Convert other formats first;
changing a file extension does not convert its contents.

The upload overwrites the audio and embedded tags, artwork, ratings, and lyrics.
The server filename, playlist links, ordering, and transcription lock stay intact.
All playlists linking to the song use the replacement. Other files, including
existing NoVocals versions, are not overwritten. The song list and any queued
copy refresh after replacement, and the player reloads the new audio.

Only the job owner, contributors, or an administrator can replace songs.
Active downloads and conflicting mutations or transcriptions return `409`.
The server requires FFmpeg's `ffprobe` (configured through `FFMPEG_PATH`) to
verify an audio stream before replacement. Invalid uploads or unavailable
validation tools leave the original file unchanged.

`POST /api/jobs/:id/files/:name/replace` accepts `multipart/form-data` with exactly
one `file` field and no other fields. URL-encode the full server filename,
including `[NoVocals]/`. A successful response contains the refreshed `file`
descriptor (including its versioned `streamUrl`) and song `metadata`.
Missing, invalid, or mismatched audio returns `400`; files over 512 MB return `413`.

## Transcription and job player

Set `TRANSCRIPTION_ENDPOINT` in `.env` to the transcription service's complete URL,
for example `http://localhost:4317/api/transcribe`, then restart the server.
The server sends the selected audio from disk; the browser never uploads another copy
or contacts the transcription service directly.

In job details, select the microphone icon beside a song to open **Transcribe song**.
Microphone buttons are disabled unless the page's transcription health check reports
**Active**. The hover message asks you to refresh once the service is available.
The dialog's top-right lock toggle can lock or unlock transcription. Changing it
hides the processing options; **Submit** saves only the lock change without starting
transcription or requiring the transcription service. **Cancel** discards the change.
The lock can also be changed from **Edit song metadata**.
**Generate NoVocals Only** hides the other options and runs vocal separation without
transcribing or changing the original song or its embedded lyrics. For locked songs,
it is the only option and is selected automatically. This mode requires an active
transcription service and reports **No-vocals version created** on success.
Optionally choose a **Language** from the dropdown. **Auto-detect** leaves the
language unspecified. A selection sends its short code as `language`, for example
`"language": "vi"` for Vietnamese. Language selection works with or without lyrics;
actual language support depends on the transcription service's selected backend.
Enable **No Vocals** to request the transcribed song plus a no-vocals MP3; the
service enables vocal separation for this request. **Viet Lyrics Fallback** enables
the fallback pass when the service's opening retry triggers and automatically
selects Vietnamese, locking the language dropdown while enabled. Both options
start unchecked and explicitly send their enabled or disabled state.
Optionally enable **Add lyrics**, enter the lyrics, and select exactly one mode:

- **Prompt**: biases recognition toward known words.
- **Align** (default): maps authoritative lyric lines onto ASR timing.
- **Correct**: replaces recognized text while preserving ASR segment timing.

The info icons show these descriptions on hover or keyboard focus. **Cancel** closes
the dialog without sending anything. **Submit** closes the dialog immediately and
shows **Transcription request sent** beside the song while the request continues.
The page refreshes the song status and files when the request finishes; errors are
shown on the page. Owners, contributors, and administrators can transcribe idle jobs.
Job deletion, reruns, and contributor changes are blocked while transcription is
in progress. Individual songs can still be deleted unless that song has a pending
transcription or deletion. Deleting one song leaves other songs' buttons available;
file deletion and audio replacement steps are serialized to avoid conflicting writes.
Only the requested song's transcription button is disabled; other songs can still
be submitted. Requests for different songs in the same job are processed one at a
time to avoid conflicting audio replacements. Waiting songs also show
**Transcription request sent**. Duplicate requests for a pending song return `409`.
Once submitted, transcription cannot be cancelled from the app.

Each submitted song shows its latest transcription status beside its name:
**Transcription request sent**, **Transcribed**, **Transcription failed**, or
**Interrupted**. Statuses refresh automatically and persist across page refreshes
and server restarts. Hover over a status for request and finish times and any error.
Shared accounts can read these statuses and saved settings for songs in their
granted libraries, while all mutation actions remain unavailable.
**Transcribed** means the response was validated and the returned audio saved, not
merely that the service responded. Unfinished requests become **Interrupted** after
a server restart and are not retried automatically. Submitting again replaces the
song's latest status; songs without a tracked request have no status indicator.

`POST /api/jobs/:id/files/:name/transcribe` accepts JSON `{}` without lyrics or
`{ "lyrics": "Known lyric lines", "lyrics_mode": "align" }` with lyrics. URL-encode
the complete filename, including `[NoVocals]/` for accompaniment tracks. The server
forwards a multipart POST containing `file`, plus `lyrics`, `lyrics_mode`,
`language`, `NoVocals`, `NoVocalsOnly`, `VietLyricsFallback`, and `Multilingual` when provided. These flags must
be JSON booleans and are forwarded as `true` or `false`. Omitting `NoVocals` uses
the service's default (`false`); omitting `VietLyricsFallback` retains its saved
endpoint setting. Enabling `VietLyricsFallback` forces `language` to `vi`.
The dialog's **Multilingual** checkbox defaults to unchecked and explicitly sends
`false`; checking it sends `true`. Omitting `Multilingual` in an API request leaves
the service's default unchanged.
`{ "NoVocalsOnly": true }` skips transcription and takes precedence over the other
options, which are not forwarded in this mode. The service returns the no-vocals
MP3 directly; it is saved as `[NoVocals]/[NoVocals] <original stem>.mp3`, regardless
of the original audio format. Accompaniment-only ZIPs and older ZIPs containing
the original plus accompaniment are also accepted. Only the accompaniment is
installed; the original file and its transcription lock remain unchanged.
Language codes must match an option in the dropdown.
Lyrics must be nonempty and at most 100,000 characters; the existing
128 KB JSON request limit also applies.

For normal transcription, the service must return audio in the original format, or a ZIP containing the exact
original filename plus any accompaniment audio. Except in NoVocals-only mode, the original song is replaced;
other audio files are placed in the job's `[NoVocals]` folder and persisted in its
file list. Non-audio ZIP entries are ignored. Invalid audio, unsafe or duplicate ZIP
names, and archives missing the original song are rejected before replacement.
Responses and expanded archives are limited to 512 MB, with at most 100 ZIP files.
Transcription requests have a one-hour timeout, including the response download.
Existing files are staged and restored if replacement or job persistence fails.
Failed upstream requests leave the original files unchanged. There is no automatic
retry, since a disconnected upstream service may still be processing the request.
Reverse proxies must permit long-running requests for this route.

Select a song's name or file icon to open `/job/:id/player` with that song selected.
The queue includes original and `[NoVocals]` tracks, with search, previous/next,
shuffle, repeat, and automatic next-track playback. Native audio controls provide
play/pause, seeking, and volume. Some browsers require pressing play after navigation.
Playback format support depends on the browser.

The **SYLT** selector shows embedded synchronized MP3 lyrics with millisecond
timestamps, highlights the current line, and allows seeking by selecting a line.
The active line uses larger text and the current palette's accent color, brightened
in the fullscreen lyrics overlay. **Copy lyrics** in SYLT mode includes each
timestamp as `[mm:ss.mmm]` before its text; copying USLT keeps plain text only.
**USLT** displays the embedded plain-text lyrics. Untagged songs remain playable.
Owners, contributors, and administrators can use **Edit lyrics**, then **Save lyrics**.
Like ssMusic_Player, SYLT uses a single text field with one `[HH:MM:SS.mmm] text`
entry per line. Edit timestamps and text directly, or add/delete lines. Blank rows
are ignored; a timestamp alone keeps an empty timed lyric. Use `\n` for a line
break within a lyric, `\r` for a carriage return, and `\\` for a literal backslash.
Invalid timestamps or exceeded limits show an error and prevent saving.
USLT remains plain text. **Clear SYLT** or **Clear USLT** removes that format only
after saving. Switching lyric types keeps both drafts; **Cancel** discards them.
Only changed formats are saved. Edits remain attached to the original song
even if playback advances, and saving does not restart playback.
Title, artist, album and supported embedded cover artwork are read from MP3 tags.
Streaming uses authenticated, byte-range-enabled `/api/jobs/:id/stream/:name`;
metadata is available at `/api/jobs/:id/lyrics/:name`. All approved users can listen.
Accompaniment files also support individual downloads, deletion, ZIP downloads,
and are preserved across reruns.

## API URL submission

Sign in with an approved user's passkey and open **User settings** using the gear button
in the header. Enter a **PAT name**, then select **Generate PAT**. The dialog displays the
Private Access Token exactly once; use **Copy PAT** and store it securely before closing.
The server stores only its SHA-256 hash. Tokens are never recoverable from listings,
including administrator views. Multiple named PATs can be active at the same time.

Submit a YouTube Music URL using the `X-PAT` header (not `Authorization: Bearer`):

```bash
curl --request POST "https://localhost:4000/api/jobs" \
    --header "X-PAT: ssyt_pat_REPLACE_WITH_YOUR_PAT" \
    --header "Content-Type: application/json" \
    --data '{"url":"https://music.youtube.com/watch?v=VIDEO_ID"}'
```

PowerShell 7 example, with the PAT already in the `SSMUSIC_PAT` environment variable:

```powershell
Invoke-RestMethod -Method Post -Uri 'https://localhost:4000/api/jobs' `
        -Headers @{ 'X-PAT' = $env:SSMUSIC_PAT } `
        -ContentType 'application/json' `
        -Body (@{ url = 'https://music.youtube.com/watch?v=VIDEO_ID' } | ConvertTo-Json)
```

Use HTTPS with a trusted certificate. For local testing with the generated self-signed
certificate only, curl accepts `--insecure` and PowerShell 7 accepts `-SkipCertificateCheck`.
Successful submission returns `202 Accepted` and the job, including its ID. The job is
attributed to the PAT owner. Missing or invalid credentials return `401`, invalid URLs
return `400`, and duplicate URLs with the same download format return `409` with
the existing job.

PATs inherit their owner's current API permissions and do not expire automatically.
Use the trash button in **User settings** to delete a PAT immediately. Administrators
can open **Admin**, select a user in **All users**, and remove that user's PATs from
**User details**. Revoking user access deletes all their PATs; reapproval does not restore them.

PAT management requires a logged-in passkey session, not a PAT:

- `GET /api/auth/pats`: list your PAT IDs, names and creation dates.
- `POST /api/auth/pats` with `{ "name": "Home automation" }`: create a PAT; the response
    includes `id`, `name`, `createdAt`, and the one-time `token` value.
- `DELETE /api/auth/pats/:tokenId`: delete your PAT.
- `GET /api/admin/users/:id`: administrator-only user details and secret-free PAT list.
- `DELETE /api/admin/users/:id/pats/:tokenId`: administrator-only PAT deletion.

The old `/api/auth/api-token` endpoint remains removed. Legacy API tokens are not
accepted; generate new PATs from User settings for automation. Bearer authentication
is reserved for passkey sessions, including the Android login flow above.

## Database storage

PostgreSQL 17 is required for Docker and native execution. Configure `DATABASE_URL`
or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`; Docker Compose supplies
these values for its bundled database service. Native execution requires a reachable
PostgreSQL server and the `pg_trgm` extension. The application initializes its schema
on startup, so the configured role needs schema and extension creation privileges.

Users, credentials, sessions, jobs, songs and playlist memberships have indexed
tables. Flexible metadata uses JSONB, while library paging and search execute in
PostgreSQL. The driver uses an asynchronous connection pool; set `DATABASE_POOL_SIZE`
to change its default of 10 connections. Private passkey keys stay in authenticators.

Use `pg_dump` and `pg_restore` for database backups and recovery. Back up the media,
TLS certificates, library ZIPs, and deployment configuration separately. Protect
database backups as sensitive data and keep them outside the public directory.

Run one app instance: download scheduling, file mutations, WebAuthn challenges and
rate limits still use process-local state. Some large organization/export operations
load full job inventories; see the PostgreSQL storage limits above.

## Scheduled maintenance

Every day at 03:00 (server local time) the server runs `yt-dlp -U` and `deno upgrade`
to keep both runtimes current. Before the update starts, it waits for any
jobs currently in progress to finish; new jobs submitted during (or just
before) the update are queued and automatically resume once the update
completes.

## System health

Open `/health` on your configured HTTPS origin to view CPU, memory, network, disk,
total media files, and transcription-service status. **Total media files** counts
existing audio and video files in the server's saved job inventory across all users,
including imported media and NoVocals audio. Playlist links and repeated references
to the same file path count once; separate stored copies count separately. Metadata,
artwork, archives, incomplete downloads, and missing files are excluded.

A scan starts at server startup and every 24 hours afterward, even with Health closed.
Health refreshes read the cached result without starting another scan. **Last scanned**
shows the last successful scan's completion date and time in your browser's local
time zone. During a scan, the previous result remains visible. A failed scan retains
that result and its timestamp, shows an error, and retries at the next daily scan.
The cache is in memory and resets on restart. `GET /api/health` includes
`media: { totalFiles, totalBytes, scannedAt, scanning, error }`; the totals and ISO timestamp
`scannedAt` are `null` until the first successful scan. Untracked files outside the
job inventory are not included. Live system metrics still refresh every three seconds.

**Admin > All users** shows each user's **Song files** (audio only) and **Storage**
(audio and video bytes) from the same daily scan, with its status and last successful
completion time. Usage belongs to the job's initiating user, not contributors or
users with linked-library access. Repeated file references count once per owner.
Users without owned media show zero after a successful scan; before then, values
are unavailable. The admin-only `GET /api/admin/users` response adds
`users[].mediaUsage: { totalFiles, songFiles, totalBytes }` and
`mediaScan: { scannedAt, scanning, error }`. `mediaUsage` is `null` until a scan succeeds;
the non-admin health response does not expose the per-user breakdown.

The server probes `TRANSCRIPTION_ENDPOINT` with
a HEAD request and a two-second timeout on each health refresh; no audio is sent.
**Active** means any HTTP response was received, including redirects and error
responses such as 404 or 500. It does not verify model readiness or a successful
transcription. Connection failures, timeouts, and an unset endpoint show **Inactive**.
Only inactive services show detail text explaining why no response was received.

## Tests

```bash
npm test
```
