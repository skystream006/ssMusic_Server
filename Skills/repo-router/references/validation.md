# Validation and smallest-test selection

Read this for execution mechanics; domain maps identify relevant test files.
Commands below use working directory
`/home/runner/work/ssMusic_Server/ssMusic_Server`.

## Existing commands

| Purpose | Command |
| --- | --- |
| Install locked dependencies when needed | `npm ci` |
| Build browser application | `npm run build` |
| Run all tests with disposable PostgreSQL | `npm test` |
| Run selected database-backed tests | `npm test -- /home/runner/work/ssMusic_Server/ssMusic_Server/test/libraryBackup.test.js` |
| Run known database-independent frontend tests | `node --test --test-concurrency=1 /home/runner/work/ssMusic_Server/ssMusic_Server/test/navigation.test.js` |
| Develop browser UI with a separate API server | `npm run dev` |
| Build and start the application | `npm start` |
| Validate Compose without printing resolved secrets | `docker compose config --quiet` |
| Validate container build when relevant | `docker compose build app` |

Sources: [package scripts](/home/runner/work/ssMusic_Server/ssMusic_Server/package.json),
[test runner](/home/runner/work/ssMusic_Server/ssMusic_Server/scripts/run-tests.mjs),
[Vite configuration](/home/runner/work/ssMusic_Server/ssMusic_Server/vite.config.js).
There is no configured lint/type-check command or dedicated browser E2E suite.
Do not add new tools just to validate a routine change.

## PostgreSQL safety

The runner starts a disposable PostgreSQL container unless `TEST_POSTGRES_URL`
is already set, checks that its database name is `ssmusic_test`, forwards test
arguments, runs test files serially, and stops its container afterward.

[createTestDatabase](/home/runner/work/ssMusic_Server/ssMusic_Server/test-support/postgres.js)
requires that URL and credentials permitted to create/drop databases. It creates
a unique fixture database and restores environment/cleans up afterward.
Some PostgreSQL tests use the designated test database directly.
Never use production databases, volumes or credentials for tests.

Do not bypass the wrapper for database-backed tests without provisioning the
required environment. Some direct tests skip without it; others fail. Inspect
imports and hooks before classifying a test as database-independent:
job-manager initialization connects to storage at module load.

## Selection and expansion

1. Choose the exact domain map row and test file(s). For pure helpers/UI, use
   direct Node tests when their imports are database-independent.
2. Add HTTP integration coverage when routes, response fields, authentication,
   permissions or client/server contracts change.
3. Add consuming-domain tests when a shared helper or stored invariant changes.
   For broad schema, middleware or shared contracts, run the full suite after
   targeted checks.
4. Build after frontend or browser-shared-module changes. UI tests use Vite SSR
   and React static rendering; manually exercise the affected browser interaction
   when playback, focus, history, layout or pointer behavior is not covered.
5. Use file selection before test-name filters. Large route suites contain
   nested subtests with common fixture setup; filtering one subtest may require
   the parent and may not avoid its setup.

FFmpeg/ffprobe-dependent cases need valid executables via `FFMPEG_PATH`.
Some job fixtures require POSIX executables, and some codec cases skip when
unsupported. Report skips and unavailable prerequisites, not just a green exit.
Use the [runtime environment reference](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/runtime/references/environment.md)
for platform-specific setup.

`TEST_POSTGRES_SCALE=1` enables the optional million-record test in
[postgres tests](/home/runner/work/ssMusic_Server/ssMusic_Server/test/postgres.test.js).
Reserve it for relevant query/index performance changes; it does not simulate
physical media or concurrent playback.

## Documentation-only Skill changes

No application build/test run is required unless documentation-specific tests
are introduced elsewhere. Verify frontmatter names/descriptions, reference links,
source symbols, selected tests, narrow routing examples and absence of secrets.
Confirm no runtime files or generated output changed. Use existing review and
secret-scanning facilities; do not introduce a validation framework.
