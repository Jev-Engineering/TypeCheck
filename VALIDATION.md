# Validation record

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
