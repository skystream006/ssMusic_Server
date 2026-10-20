---
name: runtime
description: Use when a request changes server startup or listeners, TLS, health monitoring, scheduler wiring, setup/test scripts, package or Vite build configuration, Docker/Compose, or runtime environment documentation.
---

# Runtime

## Start narrow
1. Apply [common defaults](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md) and [validation mechanics](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
2. Find the affected entry point and tests in the [domain map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/runtime/references/map.md).
3. Read the relevant section of [environment and lifecycle contracts](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/runtime/references/environment.md), not every feature route.
4. Expand to another domain only if a startup, transport, authorization, storage, or scheduling contract changes.

## Ownership and exclusions
- Own non-feature startup/listener/health wiring, TLS, health scanning, scheduler wiring, runtime scripts, package manifests, Vite, Docker/Compose, the update helper, environment example, and ignore files listed in the map.
- Access owns middleware ordering/security policy, passkeys, session/PAT rules, and per-user metric authorization; do not redesign them as runtime cleanup.
- Media-jobs owns maintenance command execution and job recovery; runtime only schedules/wires them.
- Library-transfer owns UTC backup scheduling policy and archive lifecycle; runtime only polls the service.
- Persistence owns database schema/driver/transactions. Frontend and feature API semantics remain with their domains.
- Do not run a production deployment, inspect local secret configuration, or add discovery integration elsewhere.

## Preserve
- Use Node 24 as the Docker baseline and PostgreSQL 17; do not read the broad README “Node 20+” statement as a tested minimum.
- Preserve native versus Compose ports, TLS/passkey/proxy distinctions, durable volumes, and the single-instance assumption.
- Distinguish the `/health` SPA from protected `/api/health` metrics, cached media counts from live probes, and reachability from transcription readiness.

## Targeted validation
- Health/TLS changes: select `/home/runner/work/ssMusic_Server/ssMusic_Server/test/health.test.js` and `/home/runner/work/ssMusic_Server/ssMusic_Server/test/tls.test.js` as applicable in one runner invocation.
- Add auth/job-route tests only when wiring or access contracts change; use the map for scheduler handoffs.
- Dependency/build changes: `npm run build`; Docker/Compose changes: `docker compose config --quiet` and an image build only in a disposable environment.
- There are no lint/typecheck scripts or dedicated CI workflow configurations to invoke. Documentation-only changes need source/link review, not build/test runs or added validation scripts.
