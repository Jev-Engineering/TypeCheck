# Validation record

Validation run: October 15–16, 2026 (local date October 15). **Not production ready.** Earlier authoring results are historical and preserved in `evidence/validation-authoring.txt`; old screenshots and browser-smoke results were not rerun.

## Fresh local checks

| Check | Result | Evidence |
|---|---|---|
| Dependency install | `npm install`, then clean `npm ci` passed | Reviewed lockfile v3; resolved versions in dependency inventory |
| Vulnerability review | Initial sharp high-severity advisory remediated with sharp 0.35.5; final npm audit: zero | `evidence/dependency-audit-initial.json`, `evidence/dependency-audit.json` |
| Licenses | 86 locked package entries reviewed, including optional native platforms; LGPL components explicitly identified | `evidence/dependency-licenses.json`, `docs/DEPENDENCIES.md` |
| Type checking | Passed | `evidence/current-typecheck.txt` |
| Full production build | Passed, official Discord SDK 2.5.0 bundled with full license notices | `evidence/current-build.txt` |
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
