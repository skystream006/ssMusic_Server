# Common guidance

Read once per task, not once per Skill. The canonical Skill root is
`/home/runner/work/ssMusic_Server/ssMusic_Server/Skills`.

## Discovery and portability

Each boundary has a `SKILL.md` with a YAML `name` and request-oriented
`description`. A host should expose only that metadata for selection, then load
the selected body and requested reference sections. Direct invocation of a known
domain should bypass the router.

A root Skills directory is not a promise of automatic discovery by every agent
host. No host-specific registration is installed here. Configure the host's
supported Skill search/registration mechanism to expose these canonical Skills;
verify that all eight names/descriptions are visible before relying on automatic
activation. If the host cannot register this location, explicitly load the
selected file rather than silently assuming discovery works. Do not put all
bodies or the architecture map into always-loaded instructions.

Paths in these references are absolute for this checkout. In a different
checkout, translate the prefix `/home/runner/work/ssMusic_Server/ssMusic_Server`
to the actual repository root before following links or running commands.

## Start narrow

- Choose the domain by behavior, not folder name. Use its map to find a symbol,
  route string, and test file; read bounded surrounding code.
- Read a neighboring contract section for consumption; activate its Skill when
  changing its owned semantics, storage, or interface.
- An import alone does not require loading the imported domain's full context.
- Avoid broad refactoring of shared entry points during a localized change.
- Select relevant headings from
  [README](/home/runner/work/ssMusic_Server/ssMusic_Server/README.md), not the
  complete document.

## Shared architecture constraints

- One npm package, JavaScript ESM, React/Vite frontend and Express backend.
  There is no separate backend build, ORM, distributed worker, or native app here.
- Browser code imports
  [library helpers](/home/runner/work/ssMusic_Server/ssMusic_Server/src/library.js),
  [media types](/home/runner/work/ssMusic_Server/ssMusic_Server/src/media.js), and
  [transcription languages](/home/runner/work/ssMusic_Server/ssMusic_Server/src/transcriptionLanguages.js).
  Keep those shared modules free of Node-only dependencies and initialization.
- Feature ownership applies at symbol/route granularity in
  [server](/home/runner/work/ssMusic_Server/ssMusic_Server/src/server.js) and
  [main](/home/runner/work/ssMusic_Server/ssMusic_Server/frontend/src/main.jsx).
  Runtime owns server wiring, not every HTTP handler.
- Domain stores own business rules even when they execute SQL. Persistence owns
  schema, driver and catalog-projection mechanics. Access owns authorization
  policy; UI guards never replace server checks.

## Default exclusions

Do not load generated
[public output](/home/runner/work/ssMusic_Server/ssMusic_Server/public),
[dependencies](/home/runner/work/ssMusic_Server/ssMusic_Server/node_modules),
[installed runtimes](/home/runner/work/ssMusic_Server/ssMusic_Server/runtime),
real [.env](/home/runner/work/ssMusic_Server/ssMusic_Server/.env),
[data](/home/runner/work/ssMusic_Server/ssMusic_Server/data),
[media output](/home/runner/work/ssMusic_Server/ssMusic_Server/output),
[import staging](/home/runner/work/ssMusic_Server/ssMusic_Server/import-storage),
or [completed imports](/home/runner/work/ssMusic_Server/ssMusic_Server/import-storage-completed).
Some are absent in a fresh checkout. Never copy secrets, media, database dumps or
private TLS keys into references. Inspect configuration templates instead.

External transcription and Android client implementations are outside this
repository. Describe only their local contracts. Read the lockfile only for
dependency/build work, and binary assets only for an explicitly relevant change.

## Maintenance

Each invariant has one authoritative domain reference. Link to it instead of
copying it. After changing a contract or boundary, update that owner's map/reference
and the router only if routing changed. Verify named symbols against source;
line numbers alone are not durable locators.
