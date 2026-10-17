# Native text moderation — issue 39 validation

Scope: repository/software validation on October 17, 2026. No live Discord moderation, paid provider evaluation, production database access or deployment. Historical PR #38 was integrated after it merged; its image scope and shared throttling remain intact.

| Check | Actual outcome |
|---|---|
| npm ci --no-audit --no-fund | Passed, 44 packages installed; local npm blocked esbuild postinstall under its install-script policy, and the subsequent official SDK bundle succeeded |
| npm run check / npm run build | Passed |
| npm test | 320 passed, zero failed/skipped; mocked software behavior, not classifier quality |
| npm audit --audit-level=high | Zero vulnerabilities |
| node scripts/review-dependencies.mjs | Passed |
| Release guard/source/migration/hosting tests | 13 passed, three platform-specific skips on Windows; CI runs these on Linux |
| Offline browser | 32 desktop/mobile checks passed, zero page errors; synthetic SDK/transport only |
| PostgreSQL | General, hash, historical and new text persistence checks passed against disposable PostgreSQL 16 |
| MySQL | 104 general assertions plus hash/historical/text persistence checks passed against disposable MySQL 8.0.46 |
| npm run test:compose | Passed: image/in-image tests, repeated migrations, text persistence, readiness/auth rejection, DB outage/restart, durable recovery and database/object/key restore |
| Text dataset validator | 70 distinct synthetic cases: 30 tuning, 40 held-out variants; zero provider calls; accuracy unmeasured |
| Reviewed scam references | No changes under data/scams; 33 user-reviewed images/provenance preserved |

Receipts: issue39-tests.txt, issue39-release-tests.txt, issue39-mysql.txt, issue39-postgres.txt, issue39-compose.txt, issue39-container-{result,validation}.json and issue39-browser-smoke.json. Six text UI screenshots show compiled implemented UI with an offline/synthetic banner. Reproduce with build followed by scripts/browser-smoke.py (CHROMIUM_EXECUTABLE configured; BROWSER_EVIDENCE_PREFIX=issue39-).

Text-specific coverage includes opt-in/defaults, no applicable-rule calls, exact Unicode/Markdown/code/link boundaries, empty/unavailable/over-limit abstention, privacy, guild/permission isolation, same-guild links, create/edit/delete ingestion, digest deduplication, stale source checks, cached recovery, mixed one-sanction policy, malformed/failed provider responses, bounded retries/quotas, modality-sensitive approval, duplicate calibration, false-positive/insufficient-context gates, severe second verification, deployment acceptance and transactional/idempotent starter installation/deletion/rollback. Prompt-injection tests verify trust separation and preservation of untrusted evidence; mocked scores do not prove model injection resistance.

Review found and addressed attachment-set changes during mixed decisions, cached image-policy drift, missing-text score presentation (now null, never a fabricated negative probability), rejection of extraneous text-test context/image sources, text-specific fingerprint versions, dataset validation in CI, and browser label selectors. Prior image approval fingerprints remain stable when the text switch changes. No destructive SQL migration is needed; older-executable JSON downgrade constraints are documented in docs/TEXT_MODERATION.md.

Remaining external acceptance: actual provider responses/quality and cost, language/community calibration with adjudicated blind held-out labels, live Discord intent redaction/create/edit/delete/reconnect/moderation, and independent production security/operations sign-off. Production publication now requires separate explicit manual dispatch after successful exact-main CI. Keep acceptance/enforcement defaults unchanged until the relevant live gates pass.
