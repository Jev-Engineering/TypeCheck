![TypeCheck: text and image moderation for Discord, with separate text and image cards flowing through a pink policy frame.](docs/assets/typecheck-banner.svg)

# TypeCheck

Cost analytics: Overview and **Cost & Usage** report guild-scoped attempts, reported input tokens and **estimated** Jev input-token spend. Retries, verification and credential tests are tracked separately. Administrators supply revisioned rates; missing rates and unknown usage produce coverage warnings, never an invented full bill. Legacy daily totals remain separate. See [cost accounting](docs/COSTS.md), [API](docs/API.md) and [validation](VALIDATION.md). Existing installations require forward migration 002; no deployment or production acceptance is implied.

*Formerly Jev Image Guard.* Text and image moderation for Discord, powered by Jev.

**Version 0.1.0 · implementation candidate · October 17, 2026**

A Discord text and image moderation bot with an embedded management Activity. Native text rules analyze the complete message through Jev’s JSON text API. Image-content rules analyze an image; reference rules compare images, checking compatible normalized hashes before Jev. One deterministic policy engine resolves mixed messages with at most one user sanction. **Text moderation starts disabled**, requires explicit administrator configuration, separate text calibration approval and the existing enforcement gates.

**Live acceptance remains open.** Fresh dependency installation, type checking, the official SDK bundle, automated tests, isolated PostgreSQL and MySQL integration, and an offline Compose recovery/restore drill passed. Real Discord/Activity acceptance, representative Jev accuracy, public TLS, and independent operational/security sign-off remain open. See [VALIDATION.md](VALIDATION.md) for scope and evidence.

## Included implementation

| Area | Implementation |
|---|---|
| Bot | Gateway v10 ingestion, text/image creates and edits, reconnect/resume, durable jobs, REST actions |
| Matching | Versioned exact normalized-content SHA-256 evidence, official Jev multipart image requests, strict Noul answers, pinned model, per-action thresholds, second verification |
| Rules | Native text, image content, individual, group, any-reference, explicit any-image; deterministic priority; one user sanction per message |
| Actions | Log only, review, delete, warn, timeout, kick, ban; optional delete alongside a user sanction |
| Activity | Overview, private image previews/uploads/bulk changes, graphical rules and tests, logs, permissions, settings, credential rotation |
| Security | Live Discord authority, delegated capabilities, guild isolation, encrypted write-only credentials, origin checks, bounded image decoding |
| Persistence | PostgreSQL/MySQL migrations, private filesystem object storage, audit/evaluation records, persistent action ledger |
| Delivery | Docker/Compose, CI workflow, setup/security/API/operations guides, tests, synthetic evaluation fixtures |

### Deliberate stack choices

Node.js 22 and strict TypeScript; native HTTP, WebSocket, and browser DOM APIs; PostgreSQL (`pg`) or MySQL (`mysql2`); native image normalization (`sharp`); the official Discord Embedded App SDK bundled with esbuild. No separate Redis server is required because jobs and idempotency records live in the selected SQL database. The Activity is native TypeScript rather than React. Jev uses its documented HTTP protocol directly rather than an additional SDK layer. These choices reduce runtime components, but the custom HTTP/Gateway code still needs independent review and live soak testing.

## Install and run

Requirements: Node.js 22.13 or later, npm, a PostgreSQL 16 or MySQL 8.0.16+ database, a Discord application/bot, a TypeSafe account, and an HTTPS origin reachable by Discord's Activity proxy. Do not request the bot's Administrator permission.

```bash
cp .env.example .env
# Fill Discord credentials, database URL, public origin, and a generated master key.
npm ci
npm run build
npm test
npm run migrate
npm start
```

The final two commands require configured environment variables (optionally loaded from `.env`) and a reachable database. Detailed application registration, Activity URL mapping, permissions, and onboarding are in [docs/SETUP.md](docs/SETUP.md).

**Dependency lock:** `package-lock.json` now freezes the resolved graph. Controlled builds and CI use `npm ci`. The vulnerable sharp 0.34 line was upgraded to 0.35.5; the fresh npm audit reports zero advisories. Native-library license notices and limits are recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

### Docker Compose

```bash
cp .env.example .env
# Fill .env. Use a generated URL-safe hexadecimal POSTGRES_PASSWORD.
docker compose up -d db
docker compose build app
docker compose run --rm app node dist/server/migrate.js
docker compose up -d app
```

Compose publishes the app/database on loopback only. Put an HTTPS reverse proxy in front of the app and set `PUBLIC_ORIGIN` accordingly. Use `NODE_ENV=production` for hosted operation. The Compose image passed an isolated offline deployment drill; live Discord startup and public HTTPS are still unverified. Keep `ACCEPTANCE_APPROVED=0` until all acceptance gates pass. Only one elected process runs Gateway/worker per database/bot; other instances serve the API in standby.

## First-server workflow

Open the Activity from a guild, connect, select monitored text channels, and add a Jev API key under Settings. Choose native text or image moderation. For text, preview/customize a starter in Rules & tests or explicitly install ten disabled review-only starters; enable native text analysis under Settings, then test pasted messages or authorized same-guild message links. For images, upload a reference and test labeled samples. An administrator approves the current configuration before enabling automatic enforcement. New installations have no monitored channels and enforcement off. Kick/ban additionally require the high-impact switch and second verification. Closing the Activity does not stop the backend.

An explicit any-image rule is a separate opt-in policy and does not use Jev. Semantic matching remains review-only. Approval requirements and their statistical limitations are documented in [docs/MATCHING.md](docs/MATCHING.md).

## Local UI preview

```bash
npm run compile
npm run preview
# Open http://127.0.0.1:4173 in a local browser.
```

This separate, loopback-only preview uses synthetic data and a fake SDK. It cannot authenticate to Discord, call Jev, modify production data, or execute moderation. It is never imported into the production server. Screenshots in `evidence/` are prominently labeled offline previews.

## Validation commands

```bash
npm run check
npm test
# Dedicated migrated test database only; never a production database:
TEST_DATABASE_URL=postgresql://... ALLOW_DATABASE_TESTS=true npm run test:postgres
# Actual provider calls, charged to your key; still require live acceptance:
TYPESAFE_EVAL_KEY=... npm run evaluate -- fixtures/manifest.json
```

The live evaluation command loads `.env` only when present; set the evaluation key through your shell/secrets manager, not a committed file. The 32 synthetic cases are starting fixtures, not evidence of production accuracy. See [VALIDATION.md](VALIDATION.md), [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md), and [docs/MATCHING.md](docs/MATCHING.md).

## Project map

```text
activity/       Embedded UI source and styling
server/         Gateway, REST, API, worker, Jev, authorization, storage
shared/         Domain types, parsers, capabilities, defaults
db/             Explicit SQL migration
scripts/        SDK bundle, isolated preview, live evaluation/database helpers
tests/          Unit, native-decoder, HTTP, Gateway and worker tests
fixtures/       Original synthetic images and labeled evaluation manifest
data/scams/     Default user-reviewed scam references and original SHA-256 sums
evidence/       Actual local test output and offline browser screenshots
.github/        Proposed CI workflow
docs/           Setup, security, permissions, API, operations and acceptance
```

No user credentials, dependencies, or private Discord data are included. The source lives in the public repository [Jev-Engineering/TypeCheck](https://github.com/Jev-Engineering/TypeCheck); production releases are deployed only by the CI-gated workflow described in [deployment](docs/DEPLOYMENT.md). TypeCheck is released under the [MIT License](LICENSE).

New guilds receive the [33 starter scam references](data/scams/README.md) on first authorized sign-in. Administrators can edit or delete them; no moderation rules are enabled automatically.

## MySQL and GoDaddy Node.js Hosting

`DATABASE_URL=mysql://...` selects MySQL; `postgres://...` and `postgresql://...` retain PostgreSQL. Without `DATABASE_URL`, the server accepts GoDaddy's `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. Remove a stale PostgreSQL URL when using those variables. Credentials belong in the hosting secret manager.

Set `MIGRATE_ON_START=1` for an explicitly authorized first boot where there is no release step, then turn it off. Migration is serialized and repeatable. MySQL must be 8.0.16+; MariaDB is rejected. `DB_SSL=1` enables certificate and host verification; `DB_SSL_CA` optionally supplies a PEM CA. Non-leaders serve HTTP/API in standby while retrying election; only the winner runs Gateway/worker. See [setup](docs/SETUP.md) for storage and deployment requirements.

The MySQL port passed 155 unit/HTTP tests, the unchanged PostgreSQL harness, and 104 integration assertions on local MySQL 8.0.46. `npm run test:mysql` requires `ALLOW_DATABASE_TESTS=true` and a loopback-only `TEST_DATABASE_URL`; it must never target GoDaddy. The hosted database version, app-specific database guide, deployment, Gateway operation and live acceptance remain unverified. See [validation](VALIDATION.md).

## Exact normalized-image matching

Compatible SHA-256 digests are compared before each Jev reference comparison. Equality is shown as **Exact normalized-image match**, with no model probability, provider call, verification claim or provider tokens. Inequality is not a nonmatch: Jev still evaluates it. Other references and rules still run. This recognizes normalized JPEG byte equality, not original-file byte identity or perceptual similarity; crops, recompression and watermarks are not reliably recognized by hashes.

Legacy unversioned references remain on Jev fallback until explicitly re-uploaded from source. Existing approvals become stale because the matching fingerprint now includes the hash scheme and reference version. Exact evidence that cannot satisfy existing execution safeguards goes to review without calling Jev; severe actions still require second verification. See [matching](docs/MATCHING.md).

### Match threshold configuration

New rules use Standard (0.70). The Activity also offers Strict (0.90) and Custom numeric values from 0.5 to 1.0. Strict is a stricter threshold, not an accuracy claim; these practical starting points depend on the domain, model and images. Server action floors default to 0.70 for none/review/warn/delete and 0.90 for timeout/kick/ban. Matching uses `score >= max(rule threshold, action floor)`; the editor and test results explain the effective value. Existing saved thresholds remain intact, and threshold edits never enable enforcement or bypass approvals. Any-image rules do not use match thresholds. See [configuration and compatibility](docs/MATCHING.md#configurable-match-thresholds).


## Configurable image content analysis

Use **Image content analysis** for a reference-free administrator-defined Noul question about visible text and imagery. Editable presets, explicit context/readability gates and existing thresholds/approvals are described in [Content analysis](docs/CONTENT_ANALYSIS.md). New rules start with automatic enforcement off. Model quality and production acceptance remain separate from mocked tests and CI.

## Native text policies

See [native text architecture, boundaries and privacy](docs/TEXT_MODERATION.md), [starter inventory and examples](docs/TEXT_STARTERS.md), [labeled synthetic dataset](fixtures/text/README.md), and [repository validation](evidence/issue39-validation.md). Starters cover scams, phishing, impersonation, suspicious software, harassment, threats, sensitive information, prohibited promotion, community conduct and custom observable predicates. Installation grants no approval and never modifies existing rules. The original 33 user-reviewed scam images and their provenance remain separate and unchanged.

Text tests never moderate Discord. Submitted text is not retained in jobs, logs, notifications, exports or decision evidence. Empty, unavailable, over-limit or insufficient evidence routes to review without punishment. Links, Markdown, Unicode and code blocks are evidence; linked sites, DMs and history are not fetched. Model probabilities are estimates, not measured accuracy or verified wrongdoing. Live provider/Discord acceptance and production deployment require separate authorization.
