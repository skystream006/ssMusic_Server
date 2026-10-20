# Frontend contracts

Load only the relevant heading; backend contracts remain in their owner references.

## Entry points and request handling

[main](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/main.jsx)
owns the shared `request` helper and passes it into feature views. It preserves
HTTP status, error code and duplicate-job context on failures. Public song and
playlist pages and app-login rendering are selected separately from `App`.
`PageRoutes` is custom routing; do not introduce a second routing system for a
localized change. Preserve the existing React hooks, dialogs and confirmation
patterns. Read only the matching page function when working inside this file.

## Navigation and playback

[navigation](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/navigation.js)
distinguishes route identity from lyric-overlay history. Use `navigate` for a
route change and `replaceURL` for an already-rendered selection change.
`replaceURL` preserves history state and synchronizes the tracked URL; raw
`history.replaceState` at a consumer can break overlay Back/Forward behavior.

[MusicPlayer](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/MusicPlayer.jsx)
owns `PlaybackProvider`, queue transitions and playback session restoration.
Restoration is scoped by user and URL; avoid a second audio owner in a new view.
Use `songKey` from catalog rather than filename-only identity. Changing saved
playlist order is different from changing the transient playback queue.

## Lazy lyrics and artwork

[LyricTimeline](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/LyricTimeline.jsx)
is shared by the authenticated and public player. SYLT autoscroll must affect
only its container, respect reduced motion and leave USLT scrolling alone.
`LyricsEditor` uses
[lyricsEditing](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/lyricsEditing.js)
to preserve independent SYLT/USLT edits and send only changed formats.

`SongArtwork` uses lazy, asynchronous images from returned `artworkUrl` values,
not embedded bytes in every row. Preserve revisioned URLs and failure fallback.
`createPublicLyricsLoader` in
[PublicMedia](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/PublicMedia.jsx)
loads on expansion and deduplicates/cancels requests. Do not eagerly fetch lyrics
for collapsed views.

The API distinguishes metadata and lyric reads; scoped library URLs must be
preserved. Consult
[access policies](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/policies.md)
for owner scoping and
[media contracts](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/references/media-contracts.md)
for payload behavior rather than reconstructing endpoints in components.

## Library interactions and permissions

[MusicLibrary](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/MusicLibrary.jsx)
supports server pagination and optimistic updates. Preserve page numbering,
unrelated tracks and selection URLs when reordering; do not treat the loaded
page as the complete library.

[SongActions](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/SongActions.jsx)
centralizes UI predicates and action controls. UI visibility must reflect backend
policy, but is never authorization. In particular, Shared-account access has
explicit exceptions; consult access before changing editable fields.

Use [selectOptions](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/selectOptions.js)
and [touchControls](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/touchControls.js)
for existing ordering/drag behavior. Preserve labels, focus, disabled states,
keyboard controls and pointer alternatives when changing dialogs or actions.
