---
name: access
description: >-
  Handles ssMusic passkeys, sessions, PATs, account roles, linked-library grants,
  private media, catalog-key permissions and public share tokens. Use when
  changing who can authenticate, read, share or modify data.
---

# Access

Read [common guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md)
once. Select identity, grants, privacy or sharing in the
[map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/map.md);
inspect the named function and route guard, not all authentication code.

Read only the matching [policy section](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/policies.md).
Keep credential mechanisms separate, private-media checks owner-scoped, and
Shared-account mutation exceptions explicit. Check both JS and SQL enforcement
when changing visibility.

Consult persistence for schema/transaction changes, catalog for membership
semantics, media-jobs for file delivery/mutations, frontend for access UI, and
runtime for origin/TLS/middleware configuration.

Normally exclude download execution, archive formats, UI rendering and unrelated
deployment files. Run mapped policy tests plus affected HTTP authorization tests
using [validation guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
Cover denied access and mixed credentials as well as successful requests.
