# Validation record

## CI image remediation — October 16, 2026

PR #8 replaces the Debian build/runtime base with digest-pinned official Node 22 Alpine 3.24 and applies stable Alpine updates. The old image failed the high/critical gate with 43 high Debian findings. No scanner exclusions, severity changes or workflow bypasses were added.

- `npm run check`: passed.
- `docker build --progress=plain -t typecheck-pr8-alpine:validation .`: passed production build and **164 tests**, 0 failed/skipped. Evidence: `evidence/alpine-runtime-build.txt`.
- Read-only, network-disabled runtime smoke: Node 22.23.3, UID 1000, sharp 0.35.5 synthetic PNG decode/JPEG encode, PostgreSQL and MySQL client loading passed; runtime npm absent.
- The same pinned Trivy scanner and `--scanners vuln --severity HIGH,CRITICAL --exit-code 1` used by CI exited **0**: **0 high/critical OS or Node-package findings**. Alpine 3.24.2, 18 OS packages. Evidence: `evidence/alpine-runtime-vulnerabilities.json` records scanned image metadata. This scan does not assert that lower-severity findings or future vulnerabilities are absent.

Hosted CI must additionally verify PostgreSQL/MySQL and the Compose recovery/restore drill on the new base. Local validation used only a new image and transient smoke/scan containers; shared services and WSL were not restarted. No live providers, Discord actions, hosted database connections, deployment or merge. Historical Debian scan records below remain historical evidence; live/independent production acceptance is still separate.


## Configurable review threshold — October 16, 2026

Issue #6; isolated branch `fix/configurable-review-threshold` based on main `2f2329f`. Synthetic images, mocked Jev/Discord and MemoryStore only; no hosted database, charged provider calls or live Discord mutations. Existing cost-analytics worktree/PR, `.env` and `ACCEPTANCE_APPROVED` were not changed.

- `npm ci --no-audit --no-fund`: passed (44 packages). npm reported esbuild's install script blocked by local allowScripts policy; the subsequent SDK bundle succeeded without changing that policy.
- `npm run check`: passed; `evidence/review-threshold-check.txt`.
- `npm run build`: passed; `evidence/review-threshold-build.txt`.
- `npm test`: **164 passed, 0 failed/skipped**; `evidence/review-threshold-tests.txt`.
- `npm audit --audit-level=high`: passed, zero vulnerabilities. `node scripts/review-dependencies.mjs`: passed, 96 declarations reviewed.
- Diff checked with CRLF-aware whitespace handling, preserving existing file line endings. Initial unrelated line-ending churn was corrected before committing. No test failures occurred.

Coverage includes configurable review/action floors, equality and adjacent boundaries, empty review bands, explicit review under ignore, invalid probabilities, pinned-model mismatch, disabled rules/modes, deterministic rule/comparison precedence, and existing calibration/approval/verification/permission regressions. A worker-to-HTTP integration test starts with a mocked action-qualified result reduced to 0.8 by second verification, reads its persisted open review event as a delegated moderator, resolves it through the review API, and verifies no Discord punishment, notification or action-ledger entry. Below-default-band and ignore cases retain evaluations without opening review.

This does not establish provider accuracy, an error-rate bound, live Activity acceptance or production readiness. No local SQL/Compose drill or browser visual check was run for this policy/UI-copy change; hosted CI runs the database/Compose and runtime scan checks separately. Existing image security and live/independent acceptance gates remain in force.


## MySQL port validation — October 16, 2026

Branch `feat/mysql-store`, based on `1bf77cb`. Local host: Windows, Node 24.18.0, npm 12.2.0. Only newly created `jev-guard-validation-mysql-20261046-codex` and `jev-guard-validation-pg-20261046-codex` containers were used; published ports were loopback only. MySQL reported **8.0.46**. No shared containers or WSL sessions were restarted.

| Executed check | Result | Evidence |
|---|---|---|
| `npm run check` | Passed | `evidence/mysql-typecheck.txt` |
| `npm run build` | Passed, official SDK bundled | `evidence/mysql-build.txt` |
| `npm test` | 155 passed, 0 failed/skipped | `evidence/mysql-unit-tests.txt` |
| `npm run test:postgres` after two migration calls | Passed unchanged harness | `evidence/mysql-postgres-regression.txt` |
| `npm run test:mysql` against a fresh disposable schema | 104 assertions passed | `evidence/mysql-validation.txt` |
| `node scripts/test-mysql-startup.mjs` against an empty disposable schema | Default-off refusal; opt-in migration and HTTP with no .env passed | `evidence/mysql-startup.txt` |
| Clean `npm ci --omit=dev`, then `npm run build`, in a temporary checkout | Passed | `evidence/mysql-production-install.txt` |
| TLS: untrusted certificate rejection; trusted matching-host encrypted connection | Both passed on disposable MySQL | `evidence/mysql-tls.txt` |
| `npm audit --json`; `node scripts/review-dependencies.mjs` | 0 advisories; 96 license declarations accepted | `evidence/dependency-audit.json`, `evidence/dependency-licenses.json` |

The MySQL harness includes every original PostgreSQL assertion and adds fresh/concurrent migrations, record revisions/deletion restrictions, duplicate role/credential constraints, malformed JSON/tenant CHECK failures, FK/truncation failures, millisecond UTC sessions/expiry, concurrent nonce consumption, token usage, all five pool sessions, 20 concurrent claims over 12 jobs, guild transaction serialization, two-pool election, real connection termination and keepalive, leader-only crash reset, per-kind retention, and tombstone persistence. Lifecycle tests exercise standby takeover, loss, overlapping attempts and shutdown races; HTTP tests exercise standby health and authenticated API access with fake Discord.

Initial development attempts found TypeScript narrowing issues, string-valued MySQL lock results, rejection of a stored-generated CHECK workaround, host/container clock skew in a one-second expiry fixture, and Windows import URL handling in the startup fixture. These were corrected before the passing runs. Direct CHECK expressions worked; no CHECK or FK was dropped. The expired session fixture uses a 60-second past timestamp. TLS was tested with a disposable certificate, not provider credentials.

Still **not production ready**: the hosted GoDaddy MySQL version and app-specific database guide/TLS requirements were not observed; no GoDaddy connection, migration, deployment or live Discord/Jev acceptance was performed. Local database results do not establish that the host permits Gateway operation or durable/shared object storage. A new Docker app image build/OS scan and live network-partition/soak tests were not run; the previous image scan remains historical and its release gate stays open. The minimum MySQL 8.0.16 boundary is unit-checked; the real tested server is 8.0.46, not every supported version. CI results are separate from these local results.

## Earlier validation record

### Pre-merge runtime-image follow-up

Hosted run [38867408513](https://github.com/Jev-Engineering/TypeCheck/actions/runs/38867408513) passed the application checks, MySQL job and full PostgreSQL/Compose recovery drill. Its image scan found 25 additional high/critical Go standard-library findings because production-installed esbuild was retained in the Docker runtime. Docker now explicitly uninstalls TypeScript, esbuild and Node type declarations after building/testing, while GoDaddy can still install them for its build step.

The corrected Docker image was built locally with 155 passing in-image tests. A runtime smoke check confirmed pg, mysql2 and sharp load and build tools are absent. A new Trivy scan returned **0 critical, 43 high Debian findings, and 0 Node-package findings**; all 25 additional Go findings were removed. Evidence: `evidence/mysql-runtime-build.txt`, `evidence/mysql-runtime-vulnerabilities.json`, `evidence/mysql-runtime-review.json`. The scan still exits 1 for the existing Debian release blocker; no scanner suppression or threshold change was made. Hosted GoDaddy build-tool retention/security remains unverified.

Additional MySQL edge case: a direct whole-guild deletion with linked rules/images is rejected by InnoDB's immediate RESTRICT checks. Deleting the guild's rules, then images, then guild row in one transaction succeeds and cascades remaining records. The harness verifies both outcomes; docs/SECURITY.md records this operational difference without weakening foreign keys.



Validation run: October 15–16, 2026 (local date October 15). **Not production ready.** Earlier authoring results are historical and preserved in `evidence/validation-authoring.txt`; old screenshots and browser-smoke results were not rerun.



## Fresh local checks



| Check | Result | Evidence |

|---|---|---|

| Dependency install | `npm install`, then clean `npm ci` passed | Reviewed lockfile v3; resolved versions in dependency inventory |

| Vulnerability review | Initial sharp high-severity advisory remediated with sharp 0.35.5; final npm audit: zero | `evidence/dependency-audit-initial.json`, `evidence/dependency-audit.json` |

| Licenses | 86 locked package entries reviewed, including optional native platforms; LGPL components explicitly identified | `evidence/dependency-licenses.json`, `docs/DEPENDENCIES.md` |

| Type checking | Passed | `evidence/local-validation.json`, `evidence/current-typecheck.txt` |

| Full production build | Passed, official Discord SDK 2.5.0 bundled with full license notices | `evidence/local-validation.json`, `evidence/current-sdk.txt` |

| Automated tests | 147 passed; none failed, skipped or cancelled | `evidence/current-tests.tap` |



Host: Windows, Node 24.18.0, npm 12.2.0. Container builds also run the full suite under Node 22. Unit/HTTP/Gateway/evaluation tests use mocked providers and do not establish provider accuracy or live authorization. The CLI evaluation regression explicitly tests second-verification disagreement and action-specific threshold floors without granting approval.



## Isolated PostgreSQL and containers



`npm run test:compose` creates a unique `jev-guard-validation-*` Compose project with dedicated PostgreSQL 16 storage and random loopback ports. It never uses `.env` credentials or a production database. A development-only, explicitly mounted offline identity fixture permits API startup; Gateway and worker startup are disabled in this fixture deployment. No fake authentication handler is added to the production application.



Passed: migration 001 twice; optimistic revisions; rollback; cross-guild foreign keys and reads; queue deduplication; concurrent action claims; reconnect persistence; leader recovery of interrupted jobs; unknown action tombstones that cannot replay; quotas; one-use nonces; completed-job payload erasure. Evidence: `evidence/postgres-validation.txt`.



Passed: Docker image build and in-image tests; non-root app startup; readiness health checks; official SDK serving; unauthorized API and hostile-origin rejection; private object permissions; persisted disabled enforcement; encrypted credential/guild AAD recovery; readiness failure when the dedicated DB stops; project-only restart; recovery of interrupted jobs; database dump/restore into a separate database; image archive restore into a separate volume; key-assisted decryption after restore; public fixture secrets absent from app logs. Evidence: `evidence/container-drill.txt`, `evidence/container-validation.json`, `evidence/container-result.json`. The final result file records the exact project and execution time.



Test containers/networks are removed at the end; test volumes are retained. No shared workload or WSL VM was restarted. The machine's exhausted default address pool required an unused project-only subnet. An initial backup-volume permission failure was corrected with a short-lived root/CHOWN helper scoped only to new test backup/restore volumes; the app remains non-root with capabilities dropped. The failed attempt remains in `evidence/container-attempt-restore-permissions.json`.



## Fixes verified



- Controlled installs use `npm ci`; fixed native decoder vulnerability. A corrupt PNG shared by tests and the credential probe was replaced; a new regression asserts the corrupt checksum is rejected. Decoder safety was not relaxed.

- `/api/health` remains liveness; `/api/ready` checks PostgreSQL and Gateway (API-only development skips Gateway). Container health uses readiness. Unexpected background-loop termination exits the process for supervised recovery.

- `ACCEPTANCE_APPROVED=0` blocks production enforcement at both settings API and worker dispatch, including persisted approved rules. This is operator attestation, not an automatic acceptance certificate; never set it merely because unit tests pass.

- Private image writes use a flushed temporary file and atomic rename. This reduces partial-file replacement risk; it is not a whole-host power-loss durability guarantee.

- Browser SDK distribution carries third-party license notices. The live evaluation CLI records input/manifest hashes, prompt/model version, action floors, and optional/required second checks; it never grants rule approval.



## Still open



Real Discord Activity OAuth/proxy launch, role revocation, Gateway ingestion/reconnection, real consenting test-account moderation and rate limits have not passed. Claude's requested Chrome setup session reports progress/blockers in `evidence/claude-live-status.json`; setup is not an acceptance result.



Real Jev calls and representative held-out image accuracy remain blocked on the evaluation key and labeled corpus. Synthetic fixtures cannot close this gate. Numerical thresholds and a second call to the same model do not establish an independent false-positive bound.



Public HTTPS/proxy validation, target-specific backup automation/retention and off-host restore, independent security/operations review, live load/soak tests and hosted CI execution remain open. Container vulnerability scanning is tracked separately in `docs/DEPENDENCIES.md`; npm audit does not cover the OS image.



The application remains a single-worker candidate with private filesystem storage, at-most-once dispatch (unknown outcomes are never automatically replayed), and possible loss of moderation during unrecoverable Gateway gaps. No production release or enforcement authorization has been granted.


Final runtime scan: 0 critical and 43 high OS package findings (8 unique CVEs), with no Node-package findings. Fixable critical OS and unused npm-tool findings were removed by the runtime update; residual distro findings block production acceptance. See `evidence/security-summary.json` and `docs/DEPENDENCIES.md`. CI deliberately fails the image scan on these unresolved findings.

Live setup checkpoint (2026-10-16 03:23:48 UTC): Claude session `dd0156bf-ea5b-4a54-b0c0-bd8240ba1a06`, launched in a new PowerShell tab with `--dangerously-skip-permissions --chrome`, reports Discord app creation blocked on a user hCaptcha. The planned dedicated test guild is not yet created. Remaining inputs: completed test application credentials, consenting test users/allowed actions, authorized HTTPS host (user plans GoDaddy), TypeSafe key, and representative labeled corpus. No live checks are recorded as passed. See the dynamic `evidence/claude-live-status.json` for later updates; this checkpoint is not a permanent status claim.

## Exact normalized-image hash layer (issue #7)

Validated on isolated branch `feat/exact-normalized-hash`, based on main `2f2329f`, with synthetic images and mocked Jev/Discord only. `npm ci`, `npm run check`, `npm run build`, and `npm test` passed: **173 tests, zero failures/skips**. `npm audit --audit-level=high` found zero advisories; dependency review checked 96 declarations. Windows used Node 24.18; the official Node 22 Linux Docker build also passed its build and 173 tests. Evidence: `evidence/hash-{check,build,unit-tests,audit,dependencies,final-image-build}.txt`.

PostgreSQL 16 and MySQL 8.0.46 passed their existing integration harnesses (MySQL: 104 assertions), plus `node scripts/test-hash-databases.mjs` on each engine. The additional harness validates repeated migrations, compatible and legacy JSON reference round trips, null model/probability evidence, guild isolation, revision invalidation and zero provider quota/tokens. No DDL changes or backfill apply: legacy versions are unknown and original bytes were not retained. Both CI database jobs now run the new harness. Disposable containers `typecheck-hash-pg-20261016-01` and `typecheck-hash-mysql-20261016-01` published only random loopback ports and were removed with their anonymous test volumes. Evidence: `evidence/hash-postgres.txt`, `evidence/hash-mysql.txt`.

`npm run test:compose` passed under unique project `jev-guard-validation-hash-20261016-01` and unused subnet `10.253.216.0/28`: migrations twice, private/non-root storage, HTTP authorization/origin denial, persistence, isolated database outage/recovery, interrupted jobs, backup/restore and secret-free logs. This drill ran at the first implementation checkpoint; subsequent calibration/native-version refinements were revalidated with the final native Docker build/unit suite. Test containers/network were removed; project-owned drill volumes remain. Original validation files were preserved; this run is in `evidence/hash-compose.txt`, `hash-container-validation.json` and `hash-container-result.json`. The first build failed because a new test read a fixture absent from the Docker build stage; the test now generates its synthetic image in memory. That failure is retained in `hash-compose-first-attempt.json`. A transient named-import mismatch for CommonJS sharp was caught locally and corrected to the default import before the final successful checks.

Coordination: #6 / PR #8 (`d87bb0d`) owns configurable Jev review bands; #3 (`bb9532f`) owns provider accounting. Neither branch/worktree was modified. A separate detached integration checkout composed their code with this hash implementation, resolving policy null/provenance handling and retaining Services.call accounting. **181 tests** passed with the threshold policy; **198 tests** passed with both threshold and cost changes, including an explicit empty attempt/cost-ledger assertion for hash-only evaluation. The final combined check includes native-version approval binding and cross-revision comparison reuse. The threshold-only 181-test result is the earlier checkpoint. These are local composition checks, not merges or CI claims for the other PRs. Evidence: `hash-threshold-integration.txt`, `hash-cost-threshold-integration.txt`; `hash-integration-resolutions.patch` records the tested policy/services composition against the initial hash implementation commit, for integration review rather than blind application. When either PR lands first, resolve overlapping policy/services/UI/doc changes and rerun the suites; do not restore numerical probabilities for hash evidence.

Coverage includes identical normalization, PNG encoding/metadata equality, non-equal crops/recompression/watermarks, missing/incompatible versions, cross-guild/disabled/ineligible references, mixed rules and priorities, reuse, partial provider failure, reference/configuration invalidation, severe verification and review, permission/protected-member/deployment gates, server-derived upload versions, and calibration false positives. No new browser visual acceptance is claimed; authorized API and rendering code were checked. The live evaluator intentionally remains a provider benchmark and was not run.

No charged provider call, live Discord action, hosted database access, `.env` change, acceptance/default override, shared-service restart, WSL restart, merge or deployment occurred. Existing OS-image high-severity and live/independent acceptance release blockers remain open; this change does not suppress the image-scan gate. Exact equality is not perceptual similarity or enforcement authorization. Automatic severe hash-only sanctions require separate policy work documented in MATCHING.md.

The later Standard/Strict defaults work (#9) was discovered in the original checkout during final readback and left untouched. Integration contracts were posted to #9 and PRs #8/#10: numeric bands apply only to Jev, null hash scores must not render as zero, and existing safeguards remain. Its in-progress default/persistence changes are not included in the combined-test counts.


## Hash PR conflict and CI repair

Integrated main 116df6f into the hash feature branch, preserving the merged configurable-review policy and all HTTP/hash regressions. Exact evidence remains separate from numerical bands; the Settings explanation now states this explicitly. Local check/build and 182 tests pass. The isolated Alpine Compose drill (project jev-guard-validation-hash-sync-20261016-01, loopback ports, dedicated subnet) passed build/tests, PostgreSQL integration, migrations, recovery and backup/restore. Containers and network were removed; dedicated test volumes remain. The actual resulting image passed the unchanged pinned Trivy HIGH/CRITICAL gate with zero findings for Alpine or Node packages. No suppression or lowered gate was used; the upstream pinned Alpine runtime replaces the affected Debian packages. Evidence uses evidence/hash-main-sync-*. Historical Debian failures above remain historical evidence, not the current image result. Other live/independent acceptance gates remain open.

The original checkout and its uncommitted Dockerfile change were not modified. No charged calls, live Discord, hosted databases, shared-service/WSL restart, GitHub merge or deployment occurred.
