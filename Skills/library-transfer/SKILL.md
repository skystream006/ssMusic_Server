---
name: library-transfer
description: >-
  Handles ssMusic uploaded/local media imports, iTunes XML/ZIP interchange,
  playlist downloads, library exports and scheduled backup behavior. Use for
  bulk library movement, archive formats or backup policies.
---

# Library transfer

Read [common guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md)
once. Select import, export or backup in the
[map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/library-transfer/references/map.md);
inspect HTTP handlers only if their contract changes.

Read only the selected
[interchange/backup section](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/library-transfer/references/interchange-and-backups.md).
Preserve archive limits, path containment, cleanup/rollback, ownership, canonical
order and backup privacy revalidation. Backup dates are UTC, distinct from runtime
maintenance scheduling.

Consult media-jobs for file mutations, catalog for membership, access for
permissions, persistence for storage changes, runtime for mounts/timers, and
frontend for transfer UI. Shared import validators also serve file replacement.

Normally exclude playback UI, authentication ceremonies, unrelated download
execution and database internals. Run mapped transfer tests with disposable
files/databases; add HTTP/UI tests only when those interfaces change. Follow
[validation guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
