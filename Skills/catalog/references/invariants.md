# Catalog invariants

## Identity and membership

[library](/home/runner/work/ssMusic_Server/ssMusic_Server/src/library.js) defines
`songKey` as the serialized pair `(jobId, name)`, never filename alone.
`getPlaylistTracks` is the canonical membership/order calculation: it applies
single jobs, moves, additions, removals, per-job order and per-playlist song-key
order. `getPlaylistIds` supplies folder traversal order. Reuse these in consumers
such as exports and catalog projection rather than deriving membership anew.

Single audio/video jobs map to the protected Individual Songs/Individual Videos
entries through `individualPlaylistId` and `jobPlaylistId`. `reconcileLibrary`
keeps inventory and saved organization consistent without conflating formats.
`findNoVocals` prefers an explicit companion link and otherwise accepts only an
unambiguous same-job stem match; downloaded-file counts exclude companions.

Storage consequences of identity, including foreign keys and replacement
semantics, belong to
[persistence contracts](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/references/storage-contracts.md).

## Validated, versioned edits

[libraryStore](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryStore.js)
owns validation and mutations. Preserve acyclic folder trees, valid destinations,
protected entries, atomic operations and rejection of stale library versions.
`setLibrary` checks the submitted version; `writeLibrary` updates saved state
and rebuilds the affected projection. Do not replace this with an unversioned
whole-library save.

`preserveHiddenLibraryState` prevents edits to inaccessible content hidden from a
reader. A filtered response is not the complete persisted library. Reorder/move
operations must retain unrelated pages, playlists, memberships and hidden tracks.
`lockLibraryFile` coordinates membership edits with physical file deletion.
Unlinking one membership is not necessarily permission to delete the source file.

Preference validation uses shared `themes` and existing mode/legacy defaults.
Avoid backend-only imports in the shared library helper.

## Paging and search

The `/api/library/tracks` handler in
[server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js) validates
selection, sort, search and pagination. All Music is paginated; a selected entry
without explicit paging retains the legacy unpaged contract. Do not assume a
response contains all tracks, or silently remove that compatibility path.
Persistence owns projection counts, revisions and paging implementation.

[searchSongs](/home/runner/work/ssMusic_Server/ssMusic_Server/src/songSearch.js)
implements a separate catalog-key endpoint. Its page-size maximum differs from
library track pagination; do not merge the validators accidentally. Search is
literal substring matching with shared case/accent folding, including Vietnamese
`đ`; SQL wildcard characters are escaped. Index and query normalization must agree.

Matching originals can include public NoVocals companions, even when companion
tags do not match. Deduplicate before counts/paging. `NoVocalsOnly` filters the
matched set, not the original-match input, and has explicit accepted query values.
Keep metadata allowlists and returned media URLs narrow.

Visibility predicates, key allowlists and owner-scoped read URLs are authoritative
in [access policies](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/policies.md).
Do not replicate those rules in catalog code or assume a successful search grants
future access to a media URL.
