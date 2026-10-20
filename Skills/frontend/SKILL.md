---
name: frontend
description: >-
  Handles ssMusic React screens, navigation, playback, lyrics, account UI,
  public-sharing views, styling, accessibility and browser state. Use for
  visible interface changes or client-side behavior defects.
---

# Frontend

Read [common guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md)
once, then select the feature row in the
[map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/frontend/references/map.md).
Start with that component/helper; inspect `main` routing or `request` only when
wiring is involved. Do not load the whole application entry point.

Read only the relevant [contract section](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/frontend/references/contracts.md).
Reuse the existing playback provider, lyric timeline, navigation and controls.
Keep browser-shared modules browser-safe; UI permission checks are not security.

Consult the backend owner only when its contract or behavior changes: access
for permissions, catalog for library semantics, media-jobs for media operations,
library-transfer for imports/exports, runtime for health/build wiring.

Normally exclude SQL, backend internals, deployment files, generated output and
unrelated screens. Run the mapped UI tests plus the frontend build using
[validation guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
Exercise the affected browser flow when SSR/helper tests do not cover it.
