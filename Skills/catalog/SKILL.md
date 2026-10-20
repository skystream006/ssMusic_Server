---
name: catalog
description: >-
  Handles ssMusic personal libraries, folders, playlist membership and ordering,
  preferences, track pagination and search semantics. Use for library
  organization, catalog validation or search-result behavior changes.
---

# Catalog

Read [common guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md)
once. Select a helper, store mutation or search handler from the
[map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/catalog/references/map.md).
Inspect only the matching library/preferences route when HTTP wiring is involved.

Consult the relevant [invariant section](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/catalog/references/invariants.md).
Preserve composite song identity, canonical membership/order, protected individual
playlists, optimistic versions, hidden state and consistent search normalization.

Load persistence when stored representations, projections or query plans change;
access when visibility/credential policy changes; media-jobs for inventory
mutations; frontend for interaction changes. Existing SQL calls alone are not a
reason to load all persistence context.

Normally exclude media decoding, downloader execution, authentication ceremonies,
deployment files and bulk-transfer internals. Run mapped library tests and add
projection/search/visibility tests only as impacted, following
[validation guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
