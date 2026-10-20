# Media/job discovery map

| Topic | Starting source and anchors | Closest tests |
| --- | --- | --- |
| Submission, URL normalization, deduplication, rerun, download format | [jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/src/jobManager.js): `createJob`, `createJobRecord`, `executeJob`, `rerunJob`; [utils](/home/runner/work/ssMusic_Server/ssMusic_Server/src/utils.js): `normalizeJobUrl`, `normalizeVideoUrl` | [jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobManager.test.js), [utils](/home/runner/work/ssMusic_Server/ssMusic_Server/test/utils.test.js), [jobRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobRoutes.test.js) |
| Restart state, output classification, maintenance gate | jobManager: `loadJobs`, `persistJob`, `classifyCommandOutput`, `runMaintenanceUpdate` | jobManager |
| Titles, contributors, privacy and inventory changes | jobManager: `setJobTitle`, `setJobContributors`, `setPrivacy`, `importJobFiles`, `deleteJobFile`, `deleteJob`, `preservePrivateCompanion` | jobManager, jobRoutes; [privacyRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacyRoutes.test.js) for privacy effects |
| File listings, authenticated streams/downloads, metadata/lyrics HTTP | [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js): `listJobFiles`, `resolveRequestedFile`, `songMetadataHandler`, `/api/jobs/:id/stream/:name`, `/download/:name`, `/lyrics/:name`, `/files/:name/metadata` | jobRoutes; privacyRoutes for visibility |
| Media formats and ID3 summary/read/write behavior | [media](/home/runner/work/ssMusic_Server/ssMusic_Server/src/media.js): `mediaType`, `isPlayableFile`; [music](/home/runner/work/ssMusic_Server/ssMusic_Server/src/music.js): `readSongSummary`, `readSongMetadata`, `updateSongMetadata`; jobManager: `setSongMetadata` | [musicArtwork](/home/runner/work/ssMusic_Server/ssMusic_Server/test/musicArtwork.test.js), jobRoutes |
| Artwork generation/cache and admin regeneration | [artworkThumbnails](/home/runner/work/ssMusic_Server/ssMusic_Server/src/artworkThumbnails.js): `createThumbnailCache`, `encodeThumbnail`, `readDownloadedArtwork`; [thumbnailMaintenance](/home/runner/work/ssMusic_Server/ssMusic_Server/src/thumbnailMaintenance.js): `thumbnailSongs`, `createThumbnailMaintenance`; [fallback asset](/home/runner/work/ssMusic_Server/ssMusic_Server/src/assets/audio-thumbnail.avif) | musicArtwork; jobRoutes/privacyRoutes for endpoints; publicMedia only for changed admin UI |
| In-place replacement | [replaceFile](/home/runner/work/ssMusic_Server/ssMusic_Server/src/replaceFile.js): `createReplaceFileHandler`; jobManager: `replaceJobFile` | [replaceFile](/home/runner/work/ssMusic_Server/ssMusic_Server/test/replaceFile.test.js) |
| Transcription options, HTTP result validation, queued replacement | [transcription](/home/runner/work/ssMusic_Server/ssMusic_Server/src/transcription.js): `validateTranscriptionOptions`, `requestTranscription`, `replaceTranscribedFiles`; [languages](/home/runner/work/ssMusic_Server/ssMusic_Server/src/transcriptionLanguages.js); jobManager: `transcribeJobFile`, `executeTranscription` | jobManager, jobRoutes; UI tests only for changed options/lyrics consumers |
| External KaraokeParty playlist video add/remove/status | [karaoke](/home/runner/work/ssMusic_Server/ssMusic_Server/src/karaoke.js): `submitKaraokeJob`, `removePlaylistVideo`, `getKaraokeJob`, `mutateVideo` | privacyRoutes (KaraokeParty subtests), jobManager/utils for normalization/dedup changes |

## Configuration and boundaries

`YTDLP_OUTPUT_ROOT`, `YTDLP_PATH`, `DENO_PATH`, `FFMPEG_PATH` and
`TRANSCRIPTION_ENDPOINT` are relevant; use runtime's environment reference only
when configuration changes. The transcription server is external.

Access owns credential/visibility policy, catalog owns song membership semantics,
and persistence owns normalized writes/projections. Public sharing delivery is
in access's media-share router; do not assume it uses the authenticated resolver.
Replacement reuses `validateImportAudio` from library-transfer rather than owning
a second upload-validation implementation.

Relevant [README](/home/runner/work/ssMusic_Server/ssMusic_Server/README.md) headings:
Audio and video downloads; Metadata-only jobs; Song metadata and artwork;
Replace a song file; Transcription and job player; KaraokeParty playlist videos.
