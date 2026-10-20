---
name: repo-router
description: >-
  Routes ssMusic changes to the smallest relevant engineering domain. Use when
  ownership is unclear, a request spans layers, or starting files and tests are
  unknown. Skip when a domain Skill already clearly matches the request.
---

# Route before exploring

1. Match the request against domain Skill names and descriptions. Use the
   [routing index](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/routing.md)
   only for ambiguity, shared files, or cross-domain changes.
2. Choose one primary Skill, starting symbols/routes, and likely tests.
   Record adjacent Skills as conditional, not an automatic loading list.
3. Read [common guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/common.md)
   once. Open only the selected domain map row and relevant contract section.
4. Expand when an owned contract changes or evidence crosses a boundary.
   Consult the optional [architecture map](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/architecture.md)
   only if relationships remain unclear.
5. Combine impacted tests using [validation guidance](/home/runner/work/ssMusic_Server/ssMusic_Server/Skills/repo-router/references/validation.md).
   Check the final changed-file scope against the selected owners.

Do not read entire source trees, every Skill/reference, generated files, or the
whole test suite to route a request. This Skill owns discovery, not application
behavior. Domain metadata is the trigger surface; references are demand-loaded.
