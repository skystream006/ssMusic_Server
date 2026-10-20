---
name: persistence
description: Use when a request changes PostgreSQL connections, schema or migrations, transactions, normalized song storage, catalog projections or SQL paging, or database test fixtures.
---

# Persistence

## Start narrow
1. Apply [common defaults](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md) and [validation mechanics](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
2. Select the affected symbol and tests from the [domain map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/references/map.md).
3. Read only its section in [storage contracts](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/references/storage-contracts.md), then the implementation.
4. Expand to a caller or another domain only when its storage, identity, visibility, or response contract changes.

## Ownership and exclusions
- Own the database facade, PostgreSQL driver/schema, normalized catalog implementation, and PostgreSQL test fixture listed in the map.
- Domain stores retain business semantics: access owns account/session/share policy; catalog owns library membership and organization.
- Reuse SQL visibility from `/home/runner/work/ssMusic_Server/ssMusic_Server/src/privacy.js`; do not invent a second privacy policy in queries.
- Reuse membership semantics from `/home/runner/work/ssMusic_Server/ssMusic_Server/src/library.js`; projection maintenance is not permission to redefine them.
- Exclude media file mutation, download/transcription lifecycle, export/backup policy, frontend behavior, and deployment configuration unless a changed persistence contract requires a handoff.

## Preserve
- Await driver operations; preserve JSON/JSONB text decoding and pooled transaction context.
- Keep song identity `(job_id, name)` stable: replacement deletes can cascade memberships and public links.
- Keep metadata-only writes distinct from inventory/ownership changes and catalog rebuilds.
- Preserve filtered SQL paging, stable ordering, and the legacy unpaged selection contract.

## Targeted validation
- Driver/schema/projection changes: select `/home/runner/work/ssMusic_Server/ssMusic_Server/test/database.test.js` and `/home/runner/work/ssMusic_Server/ssMusic_Server/test/postgres.test.js` together through the shared runner.
- Add only affected library, privacy, share, or account tests from the map when those contracts change.
- Use disposable PostgreSQL only; `TEST_POSTGRES_SCALE=1` is opt-in, not routine validation.
- Documentation-only changes require source/link review, not tests, builds, or new validation scripts.
