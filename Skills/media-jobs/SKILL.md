---
name: media-jobs
description: >-
  Handles ssMusic YouTube downloads, job lifecycle, streams, audio/video files,
  metadata, lyrics, thumbnails, replacement, transcription and KaraokeParty
  video jobs. Use for processing, changing or serving media.
---

# Media and jobs

Read [common guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md)
once, then select the operation in the
[map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/references/map.md).
Read named job-manager functions, not the complete module.

Load only the matching
[lifecycle](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/references/lifecycle.md)
or [media contract](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/references/media-contracts.md)
section. Preserve serialization, safe paths, rollback, song identity and
post-persistence thumbnail refresh. Importing the job manager initializes storage;
do not import it merely to explore the code.

Consult access for permissions, catalog for membership effects, persistence for
stored projections, library-transfer for shared upload validators, and runtime for
executable/service configuration. Frontend owns player interaction.

Normally exclude account UI, unrelated deployment files and bulk archive workflows.
Run mapped tests and affected HTTP cases using
[validation guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
Report missing FFmpeg prerequisites and platform skips explicitly.
