# Issue #44 — browser onboarding validation

Scope: isolated implementation and offline/synthetic validation, 2026-10-17. No production deployment, bot controller startup, live provider calls or production data changes. Remote confirmed as `git@github.com:Jev-Engineering/TypeCheck.git`; main is the default branch. No additional filesystem AGENTS.md was found in the repository/ancestor paths; supplied machine-wide instructions were followed. Unrelated deployment/branding work stays in its own checkouts/PRs. Starter overlap was recorded on issue #41. PR #46 merged during implementation; its main commit 7e893ce was integrated, followed by the independently merged benchmark-pricing main commit d701480, preserving pack UI/API/seeding. Cross-workflow tests protect marker portability, complete imports and shared image rule identity.

## Local checks

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | Fresh locked dependency installation succeeded |
| `npm run check` | Passed |
| `npm run build` | Passed, including official Discord SDK bundle/notices |
| `npm test` | 367 passed, no failures/skips; [output](issue44-tests.txt) |
| `npm audit --audit-level=high` | Zero vulnerabilities |
| `node scripts/review-dependencies.mjs` | 96 license declarations reviewed; existing native-library license constraints unchanged |
| `node scripts/validate-text-dataset.mjs` | 70 cases; no paid calls, accuracy not measured |
| `node --test scripts/release-guard.test.mjs scripts/release-source.test.mjs scripts/migration-receipt.test.mjs scripts/hosting-handoff.test.mjs` | 13 passed, 3 existing Linux-only skips on Windows; [output](issue44-release-tests.txt) |
| `ALLOW_DATABASE_TESTS=true TEST_DATABASE_URL=... node scripts/test-onboarding-databases.mjs` | Passed separately against disposable local PostgreSQL 16 and MySQL 8.0 containers; [PostgreSQL](issue44-postgres.txt), [MySQL](issue44-mysql.txt) |
| `CHROMIUM_EXECUTABLE=... BROWSER_EVIDENCE_PREFIX=issue44-regression- python scripts/browser-smoke.py` | Existing desktop/mobile UI checks passed; no page errors/overflow; [record](issue44-regression-browser-smoke.json) |
| `ONBOARDING_NATIVE_CHROME=1 python scripts/onboarding-browser.py` with isolated `node scripts/onboarding-browser-server.mjs` | New desktop/mobile manual flow, unsupported-browser fallback, registry contract and native in-page agent passed; [record](issue44-browser.json) |
| `git diff --check` | Passed |

HTTP/unit cases cover session expiry/logout, standalone state/guild/browser/origin binding and exact redirect URI, live permission revocation and tenant isolation; plan actor/session/digest binding, explicit acceptance, stale/expired denial, safe defaults, repeat/customize/delete/overlap reconciliation, redaction and inert untrusted strings. Failure injection and concurrent application verify atomic rollback and one persisted receipt. Both SQL dialects verify canonical JSON plans, rollback, concurrent application, receipt recovery through a new service instance, tombstones and isolation. These SQL tests are wired into both hosted CI database jobs.

The original feature-head CI found a legacy persistence assertion expecting an extra duplicate text starter (11 instead of 10). The assertion now verifies one canonical preset each, correct deletion count and a durable marker; full PostgreSQL/MySQL integration passes. This changes the expected deduplication behavior without relaxing the gate. Post-integration pack persistence also passed on both dialects ([PostgreSQL](issue44-pack-postgres.txt), [MySQL](issue44-pack-mysql.txt)); full integration logs are [PostgreSQL](issue44-full-postgres.txt) and [MySQL](issue44-full-mysql.txt).

## Browser evidence and assets

The browser harness imports test fixtures only, binds to loopback, creates an isolated MemoryStore/object directory and starts no Gateway or worker. Its authority-revocation endpoint exists only in that explicitly launched synthetic harness. Playwright intercepts the external Discord authorize redirect; state cookies, callback, session bootstrap and management requests execute the actual application server code with fake Discord/Jev adapters.

Chromium **145.0.7632.6** has no `document.modelContext` or `navigator.modelContext` in the tested configuration. The manual planner passed at 1440×1000 and 390×844. A registry double separately verifies invocation/abort cleanup; it is not native browser support evidence.

Installed Chrome **155.0.8059.82**, launched with `--enable-features=WebMCP`, passed native `document.modelContext.getTools` and `executeTool` discovery/invocation without a polyfill. An author-provided in-page agent discovered all eight tools, inspected context, proposed a plan, failed to apply before acceptance, applied after the UI acknowledgement/acceptance, recovered its receipt, and lost registration on observed live authority revocation/logout. This proves that scoped standalone browser/tool path against synthetic adapters. It does not establish built-in browser-agent product support.

Eight `issue44-{starters,plan,result,fallback}-{desktop,mobile}.png` screenshots show the implemented compiled UI and carry visible **OFFLINE SYNTHETIC DEMO** labels. They are original captures with synthetic server/channel/user data, not mockups or live integration evidence. `docs/assets/agent-onboarding.svg` is original editable architecture artwork under the repository MIT license. [SHA-256 manifest](issue44-assets.json) records provenance and asset hashes. Regression screenshot duplicates are excluded; the regression JSON record is retained. Browser reruns generate different ephemeral plan IDs/digests/times and consequently new hashes; regenerate the manifest when replacing captures.

## Remaining live gates

- Actual Discord Activity iframe/proxy: parent `tools` permission delegation, compatible-agent discovery and invocation are **unverified**. TypeCheck cannot control Discord's iframe attributes. Registration success in standalone Chrome is not embedded evidence.
- Real standalone Discord OAuth: register the exact callback on an isolated test app, sign in as an administrator, verify revoked permissions and cross-guild denial in that environment. The project test credentials were verified with read-only Discord requests: application identity and membership in the administrator-selected server passed. An isolated API-only server with a separate local database is available; provider transport is disabled. The registered redirect still needs updating and the available automation browser requires human Discord sign-in. Synthetic OAuth tests are not this acceptance.
- Real provider calibration/accuracy, operational acceptance and production deployment are unperformed and remain separate. The implementation offers no accuracy or readiness certificate.

Required remaining maintainer action before declaring full live acceptance: register the standalone callback and complete human Discord login in an accessible test browser, run and record embedded discovery/invocation separately from standalone sign-in, and resolve any compatibility failures without weakening existing gates. A reviewable PR may carry this work while those gates remain open; they must not be marked complete by offline tests. Production deployment is outside this task's authorization.
