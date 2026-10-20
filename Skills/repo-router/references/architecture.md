# Architecture map — optional deep context

Do not preload this map for a known-domain task. Use the
[routing index](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/routing.md)
for selection and each domain's map for exact files/tests.

## Components

| Component | Entry points / owner map | Dependencies |
| --- | --- | --- |
| React browser app | [frontend map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/frontend/references/map.md): `main`, `PageRoutes`, `PlaybackProvider`, feature views | Same-origin API; shared browser-safe domain helpers |
| Identity, privacy and sharing | [access map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/access/references/map.md): `registerAuthRoutes`, credential middleware, privacy predicates, share routers | PostgreSQL, library membership and media resolution |
| Library/catalog | [catalog map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/catalog/references/map.md): `getPlaylistTracks`, library mutations, `searchSongs` | Access policies and persistence projections |
| Jobs and media | [media-jobs map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/media-jobs/references/map.md): job lifecycle, file mutations, media reads | Catalog, access, persistence, filesystem, yt-dlp/Deno/FFmpeg, transcription HTTP |
| Bulk transfer and backups | [library-transfer map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/library-transfer/references/map.md): imports, export preparation, backup service | Catalog ordering, media validation/mutation, access, persistence, archives |
| PostgreSQL | [persistence map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/persistence/references/map.md): pool/transactions, schema, normalized catalog | Catalog semantics and access SQL predicates |
| Runtime/deployment | [runtime map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/runtime/references/map.md): server startup, TLS, timers, health, tooling | All service entry points; Compose PostgreSQL and persistent volumes |

## Execution flow

The [frontend entry](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/main.jsx)
selects public-share views before the authenticated application. Its `request`
helper calls the API; custom navigation manages routes and lyrics history.
Vite builds the browser application into the server's static output.

The [server entry](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js)
assembles Express routes and creates an HTTP redirect listener plus an HTTPS
listener. Public share endpoints have their own token authorization and are
mounted before session middleware. Authenticated handlers delegate to domain
modules; some catalog handlers call SQL projections directly.

PostgreSQL stores accounts, sessions, jobs, normalized songs, memberships and
backup status. Media bytes, source covers, thumbnail caches, backup ZIPs and
certificates live on disk. A library export is not a complete deployment backup.

Jobs, transcription queues, backup work, thumbnail regeneration, maintenance
timers and media-count scans execute in the app process. There is no queue
service. Keep the documented single-instance deployment constraint: locks,
WebAuthn challenges and some caches are process-local.

## Shared code and deliberate coupling

- Catalog owns shared song identity, playlist ordering and search normalization.
- Media-jobs owns shared media extension classification and language options.
- Access owns JavaScript visibility helpers and SQL visibility fragments.
- Persistence consumes these contracts; it does not redefine them.
- Job mutations may update catalog membership; imports call job mutations;
  exports use canonical playlist order; public shares recheck current access.
- There is one test directory for UI helpers/SSR, services and HTTP integrations.
  There is no independent frontend package or dedicated browser E2E runner.

## Build and environment

[package scripts](/home/runner/work/ssMusic_Server/ssMusic_Server/package.json)
define `npm start`, `npm run dev`, `npm run build`, `npm test` and three runtime
setup commands. The backend runs as ESM without compilation; `npm start` builds
the frontend first. No lint/type-check script is configured.

Use [validation](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md)
for command execution and test prerequisites. Use
[runtime environment](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/runtime/references/environment.md)
only for relevant ports, TLS/passkeys, database settings, external executables,
transcription endpoint, import/backup roots and Docker configuration.

The dependency manifest/lockfile cover Express, React/Vite, WebAuthn, PostgreSQL,
ID3/media detection, archive/XML handling and system metrics. No CI workflow
directory was present when these Skills were introduced; do not invent a CI
validation command.
