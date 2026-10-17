# Issue #49 implementation validation

Validated 2026-10-17 in isolated worktree
`C:\Users\timot\Documents\projects\typecheck-consent-49`, branch
`feat/data-use-consent-49`, based on main
`52084fd7bf96267570414c956c537311c7639f3f` (includes onboarding #48 and
checksum-only refresh #50). Tests ran on code from
`722dc90b3f0307dfd4d1b4eba6c69215ed808e77`; #50 changed only `SHA256SUMS`,
so the tested implementation code is identical on the final base.
This evidence was captured before commit/push. Original checkout, its eight-file
consent WIP and unrelated benchmark work remain unchanged. No production/provider
configuration, implementation PR, merge or deployment was performed. A subsequent
user instruction authorized committing and pushing this implementation branch;
Git history and the remote branch identify the published commit. The source-file
hashes below describe the validated precommit snapshot, not a deployment receipt.

## Delivered behavior

- Two independent optional choices, false for new/legacy settings. Separate save,
  readback and withdrawal; moderation does not require either permission.
- Explicit local-only TypeSafe permission, distinct from organization-wide console
  control and from CompleteTech LLC training permission. No new collection,
  raw-content retention, dataset, export or training pipeline.
- Strict booleans, optimistic settings revisions, live administrator/guild/session
  boundaries and atomic versioned consent receipts.
- Consent transitions require the displayed notice version; stale/missing notice
  returns 409 without mutation. Unrelated/no-op saves do not renew consent.
- Packs omit consent on export, reject it on import (including false), and
  preserve destination values. Onboarding/starter application preserves all four
  combinations and grants no consent through generic setup acceptance.
- Host/provider legal identities, audit-retention limits, withdrawal limits and
  future-purpose/re-consent boundaries documented. Existing unverified fixed
  deletion wording was replaced with coordination/backup-limit language.
- Keyboard-operable labels and focused saved/conflict feedback; desktop/mobile
  synthetic browser verification and actual compiled-UI captures.

## Fresh checks

| Command/check | Result | Evidence |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | Passed; no dependency change | Install used existing lockfile; npm reported esbuild postinstall blocked by local policy, but build succeeded with its installed platform binary |
| `npm run check` / `npm run build` | Passed | Also built and tested in Node 22 Alpine image; host used Node 24.18.0 |
| `npm test` | 376 passed; zero failed/skipped | [tests.txt](tests.txt) |
| `node scripts/test-consent-databases.mjs` | PostgreSQL 16 and MySQL 8.0.46 passed | [sql.txt](sql.txt) |
| `python scripts/consent-browser.py` | Nine workflow checks, no page errors; 1440×1050 / 390×844 | [browser.json](browser.json), [desktop](desktop.png), [mobile](mobile.png) |
| `npm audit --audit-level=high` | Zero vulnerabilities reported | [audit.txt](audit.txt) |
| `node scripts/review-dependencies.mjs` | Passed; existing LGPL distribution-review notice retained | [dependencies.txt](dependencies.txt) |
| `node scripts/validate-text-dataset.mjs` | 70 synthetic cases validated; no paid calls or measured accuracy | [dataset.txt](dataset.txt) |
| Release guard/source/migration-receipt/handoff tests | 13 passed; four existing Windows skips; zero failures | [release-tests.txt](release-tests.txt) |
| `npm run test:compose` | Image/in-image tests, migrations twice, readiness, private storage, database outage recovery and DB/object/key restore passed | [compose.txt](compose.txt), [container-result.json](container-result.json), [container-validation.json](container-validation.json) |
| Pinned Trivy runtime-image scan | Zero HIGH/CRITICAL findings, exit 0 | [container-vulnerabilities.json](container-vulnerabilities.json), [scanner log](container-scan.txt) |
| `git diff HEAD --check` | Passed | Final local diff review |

The SQL run exercises actual HTTP handlers with real SQL and synthetic authority:
legacy JSON hydration, independent transitions/readback/withdrawal, invalid
booleans, stale notice/revision, failure after settings/receipt insertion, full
rollback, simultaneous writes, authorization/guild isolation, pack and onboarding
preservation, receipt cleanup and readback after reopening pools. It also reruns
existing pack, onboarding and full backend integration suites. No SQL schema
migration was needed. CI now runs the consent persistence test on both dialects.

Browser checks use the compiled Activity and actual HTTP handlers with synthetic
Discord/provider adapters and temporary in-memory storage. They cover off defaults,
visible notices, accessible checkbox names, keyboard Space, focused feedback,
independent updates, reload/reconnect readback, withdrawal, revision/notice
conflicts, mobile overflow and served legal identities. Screenshots show synthetic
settings, not real guilds/provider state. Manual inspection found readable consent
content and distinct labeled controls at both sizes. No actual screen-reader
session or live Discord/provider consent acceptance is claimed.

The Compose project was `jev-guard-validation-consent49-1792270322`; its containers
were stopped/removed by the existing harness, which retains isolated test volumes
by design. SQL containers were removed by the dedicated runner. The temporary UI
harness was stopped. Shared workloads and WSL were not restarted or terminated.

## Decisions and remaining review

- Scope is local permission recording, with provider state unknown. An API-key
  organization owner must independently manage TypeSafe's console; conflicting
  guild choices cannot be enforced by this local checkbox.
- Every consent transition is bound to the current client-declared notice version,
  including withdrawal. A stale page must reload/review before retrying. This
  does not prove a person read the notice or has all affected people's authority.
- Existing bounded audit retention is preserved for this permission-only feature.
  It is not sufficient evidence for a future data-use system after history expires.
  Material purpose changes require fresh explicit choices and a separately
  reviewed transition/evidence design; existing flags cannot activate a pipeline.
- An independent content/security reviewer, confirmation of the host's actual
  contact/deletion procedures and provider organization ownership remain maintainer
  actions. No legal approval, deletion guarantee or compliance conclusion is supplied.
- Hosted consent-PR checks have not run because nothing was committed/pushed and
  no PR was opened. Four platform-specific release tests remain for Linux CI;
  local synthetic evidence does not close future live acceptance or deployment gates.

Source/reference context: [issue #49](https://github.com/Jev-Engineering/TypeCheck/issues/49),
[merged onboarding #48](https://github.com/Jev-Engineering/TypeCheck/pull/48),
[merged packs #46](https://github.com/Jev-Engineering/TypeCheck/pull/46),
[TypeSafe announcement](https://typesafe.ai/blog/jev-1-14),
[API reference](https://docs.typesafe.ai/api),
[OpenAPI](https://api.typesafe.ai/openapi.json). Provider references were inspected
during issue triage in this session; the implementation does not infer a provider
setting or introduce an undocumented provider API.
