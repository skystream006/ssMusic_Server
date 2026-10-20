# Routing index

Read only the section needed to resolve ownership. Skill frontmatter is the
authoritative trigger description; this index adds tie-breakers, not duplicate
Skill bodies.

## Domain selection

| Request focus | Skill | Escalate only when |
| --- | --- | --- |
| Visible controls, playback, navigation, browser state, accessibility | [frontend](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/frontend/SKILL.md) | The backend contract/behavior must change |
| Who may log in, read, mutate, grant access or share | [access](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/SKILL.md) | Storage, delivery, membership or UI behavior also changes |
| Library structure, ordering, membership, preferences, search meaning | [catalog](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/catalog/SKILL.md) | SQL projections, permissions, media lifecycle or UI changes |
| Download/job lifecycle, media bytes/tags, thumbnails, transcription, KaraokeParty | [media-jobs](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/SKILL.md) | Catalog, access, storage or runtime contracts change |
| Imports, exports, playlist archives, backup policy | [library-transfer](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/library-transfer/SKILL.md) | File mutations, membership, permissions, schema or mounts change |
| SQL structure/performance, migrations, transactions, projections | [persistence](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/SKILL.md) | Domain meaning or visibility policy changes |
| Startup, TLS, Docker, environment, health, installers, test harness | [runtime](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/runtime/SKILL.md) | A wired service's behavior changes |

## Shared-file tie-breakers

| File | Scope → owner |
| --- | --- |
| [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js) | Listener/setup/health → runtime; credential order and guards → access; library/preferences/tracks → catalog; jobs/media → media-jobs; imports/exports/backups → library-transfer |
| [songSearch](/home/runner/work/ssMusic_Server/ssMusic_Server/src/songSearch.js) | `attachSearchKey`, `requireSearchKey` → access; `searchSongs` validation/results → catalog; query-plan/index changes → consult persistence |
| [main](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/main.jsx) | Rendering/state → frontend; changed account or job contracts → corresponding backend owner |
| [libraryStore](/home/runner/work/ssMusic_Server/ssMusic_Server/src/libraryStore.js) / [authStore](/home/runner/work/ssMusic_Server/ssMusic_Server/src/authStore.js) | Business rules → catalog/access, despite SQL inside; schema/transaction mechanics → persistence |
| [scheduler](/home/runner/work/ssMusic_Server/ssMusic_Server/src/scheduler.js) | Timer wiring → runtime; runtime-update gate → media-jobs; backup due-date policy → library-transfer |

Do not add generic API, shared-library, integration, worker or testing Skills
for concerns already owned above. Tests follow the behavior, not their folder.

## Cross-domain protocol

1. Name the primary behavior owner and smallest starting symbols/tests.
2. Establish the contract before editing consumers; avoid guessing a migration
   is required when an existing representation may already support the change.
3. Follow changed dependencies: stored representation (if needed) → domain
   behavior → route/authorization → UI → union of impacted tests.
4. Each owner edits its own rules. Consult one reference section at a time.
5. Broaden tests for a shared invariant; do not broaden repository reading merely
   because a test file covers several features.

Consultation edges: frontend → relevant backend owner; catalog → access/persistence;
media-jobs → catalog/access/persistence; library-transfer → media-jobs/catalog/access/
persistence; access → persistence and delivery/membership contracts; persistence →
catalog/access semantics; runtime → the affected service owner. These are not
mandatory loading chains.

## Routing acceptance examples

| Change request | Initial discovery | Conditional cooperation | Targeted validation |
| --- | --- | --- | --- |
| Reject invalid `NoVocalsOnly` song-search values | catalog → `searchSongs` | access only for key permissions; persistence only for query behavior | Search cases in [privacyRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacyRoutes.test.js) |
| Fix Back when closing lyrics | frontend → `createNavigationHistory`, affected player | No backend Skill for a history-only change | [navigation](/home/runner/work/ssMusic_Server/ssMusic_Server/test/navigation.test.js); affected consumer tests/build |
| Keep retained NoVocals private after original deletion | access → companion policy, then media-jobs → deletion | persistence if stored restrictions/SQL behavior change | [privacy](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacy.test.js), [jobManager](/home/runner/work/ssMusic_Server/ssMusic_Server/test/jobManager.test.js), [privacyRoutes](/home/runner/work/ssMusic_Server/ssMusic_Server/test/privacyRoutes.test.js) |
| Add editable playlist descriptions | catalog → decide personal-entry versus source-job ownership | persistence only for storage/projection changes; media-jobs if source-job metadata; frontend for editing/display; access if permissions change | [library](/home/runner/work/ssMusic_Server/ssMusic_Server/test/library.test.js), affected storage/routes, [songActions](/home/runner/work/ssMusic_Server/ssMusic_Server/test/songActions.test.js), build |
| Configure a Docker-mounted backup folder | library-transfer → existing backup root/lifecycle, then runtime → mount/environment | No playback, passkey or downloader context unless implicated | [libraryBackup](/home/runner/work/ssMusic_Server/ssMusic_Server/test/libraryBackup.test.js), export tests if affected, disposable Compose validation |
