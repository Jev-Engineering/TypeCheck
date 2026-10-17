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

## Live Discord and compatibility results

[Sanitized live evidence](issue44-live.json) records actual Discord OAuth code exchange with the exact registered callback, browser-bound state, bootstrap and live administrator authority. The user authenticated in an isolated visible Chrome session. Native tools discovered all four presets, proposed nine disabled review-only rules, refused unaccepted application, recorded the user's explicit acceptance through the authenticated review UI, applied only to the dedicated local SQL database and recovered the same receipt. All rules remained disabled/nonautomatic/unapproved; safe pause kept enforcement off and logout removed every tool. A credential-less test was safely refused without a provider call. No Gateway/worker/controller started and no production configuration database was touched.

The existing project's credential file identifies a different test application ID from the initially supplied ID. Read-only Discord application identity and membership requests established the configured TypeCheck Test application and the user-designated server. Credentials were consumed privately through ignored local test configuration and never included in committed files. The test OAuth callback was temporarily added while preserving the prior redirect, then removed after validation; the original redirect list was read back from Discord. Real guild, user and channel identifiers/content are omitted from the committed evidence. No live screenshots containing private server information were published.

The actual Discord web Activity was launched in the designated server, inspected, and then left. Chrome 155's native `document.modelContext` exists inside its proxy iframe, but `allowsFeature('tools')` is false. The parent allow attribute is `autoplay; encrypted-media`. A temporary constant-only, read-only compatibility registration was rejected with `NotAllowedError`; nothing was exposed or invoked, no application services were touched, and parent policy was not modified. This resolves the iframe constraint for this tested client: browser-agent onboarding requires the independently authenticated standalone dashboard. Other Discord clients and built-in browser-agent products remain unverified.

Remaining external acceptance: permission revocation with a dedicated second live Discord account, real provider calibration/accuracy and other operational/deployment acceptance are unperformed. Synthetic permission-change tests and actual per-call live authority checks are not a claim that a second-account live revocation scenario passed. No paid provider evaluation or production deployment is authorized or claimed. These limitations do not turn starter templates into verified classifiers or relax existing enforcement gates.

Hosted Validate push and PR runs for the implementation head passed full unit/build, PostgreSQL/MySQL/pack/onboarding persistence, benchmark arithmetic, Compose recovery/restore, backup tests and runtime-image security scan. Current final-head check links are recorded on PR #48; a green build grants no production deployment authority.
