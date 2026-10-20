# Frontend discovery map

Choose a row, then read named symbols instead of whole components.

| Topic | Starting source and anchors | Closest tests |
| --- | --- | --- |
| App shell, route selection, login/admin/job screens, polling, API errors | [main](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/main.jsx): `request`, `usePolling`, `PageRoutes`, `LoginPage`, `UserSettingsPage`, `JobsPage`, `JobPage`, `HealthMetrics`; [HTML entry](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/index.html) | [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js); backend contract tests only if changed |
| Library folders, paging, selection, reorder, backup dialogs | [MusicLibrary](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/MusicLibrary.jsx): `MusicLibrary`, `reorderPlaylistTracks`, `EditPlaylistDialog`, `ExportLibraryDialog` | [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js) |
| Queue, shuffle/repeat, session restoration, audio/video, artwork | [MusicPlayer](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/MusicPlayer.jsx): `PlaybackProvider`, `nextPlaybackSong`, `queueSongNext`, `readPlaybackSession`, `SongArtwork` | [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js) |
| Lyrics display/editing | [LyricTimeline](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/LyricTimeline.jsx), [lyricsEditing](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/lyricsEditing.js), `LyricsEditor` in the player | [lyricsEditing](/home/runner/work/ssMusic_Server/ssMusic_Server/test/lyricsEditing.test.js), [publicMedia](/home/runner/work/ssMusic_Server/ssMusic_Server/test/publicMedia.test.js), player cases in songActions |
| History and lyrics overlay Back/Forward | [navigation](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/navigation.js): `createNavigationHistory`, `replaceURL`, `useNavigation` | [navigation](/home/runner/work/ssMusic_Server/ssMusic_Server/test/navigation.test.js) |
| Metadata, rating, replacement, transcription, privacy/share actions | [SongActions](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/SongActions.jsx): dialog/control exports, permission predicates; [selectOptions](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/selectOptions.js) | [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js) |
| Account settings and granted libraries | [AccountSettings](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/AccountSettings.jsx), [SharedLibraries](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/SharedLibraries.jsx) | [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js) |
| Public media/playlist views and admin share/thumbnail status | [PublicMedia](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/PublicMedia.jsx): `createPublicLyricsLoader`, `PublicMediaView`, `PublicPlaylist`; [AdminMediaShares](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/AdminMediaShares.jsx) | [publicMedia](/home/runner/work/ssMusic_Server/ssMusic_Server/test/publicMedia.test.js) |
| Import UI and adding job files to playlists | [ImportMusic](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/ImportMusic.jsx), [JobPlaylistDialog](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/JobPlaylistDialog.jsx) | [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js) |
| Submission, job sorting and touch drag/drop | [jobSubmission](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/jobSubmission.js), [jobSorting](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/jobSorting.js), [touchControls](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/touchControls.js) | [jobSubmission](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobSubmission.test.js), [jobSorting](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobSorting.test.js), [touchControls](/home/runner/work/ssMusic_Server/ssMusic_Server/test/touchControls.test.js) |
| Styling/branding | [styles](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/styles.css), [public media styles](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/publicMedia.css), [source icon](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/assets/ic_launcher.png) | Relevant component suite, build and affected viewport/browser flow |

## Escalation and architecture

Read [contracts](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/frontend/references/contracts.md)
for the selected feature. Shared data semantics belong to catalog/media-jobs;
permission semantics belong to access. Runtime owns
[Vite configuration](/home/runner/work/ssMusic_Server/ssMusic_Server/vite.config.js).
Source edits must not target generated static output.

The broad songActions/publicMedia suites load multiple components through Vite
SSR; their names do not describe every feature they cover. There is no dedicated
test file for every page. Search the listed suite for the affected component or
behavior, and use browser verification for interaction gaps.

Configuration: `DEV_API_TARGET` affects the development proxy; passkey UI testing
also requires an origin matching the server's configured RP/origin.
Relevant README headings: Shuffle and repeat; Personal music library; Public
media links; Passkey access; Transcription and job player.
