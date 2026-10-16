# TypeCheck

*Formerly Jev Image Guard.* Image moderation for Discord, powered by Jev.

**Version 0.1.0 · implementation candidate · October 15, 2026**

A Discord image-only moderation bot with an embedded management Activity. A member posts an attachment; Jev compares it to this server's reference library; the policy engine chooses an action; the continuously running backend executes eligible actions. Text-only messages are ignored.

**This is not a production acceptance certificate.** Local TypeScript compilation and 142 automated tests passed. The compiled UI passed 14 offline browser checks with synthetic SDK/transport data. Real Jev accuracy, real Discord moderation/Activity authentication, the resolved dependency graph, PostgreSQL integration, and Docker deployment have not been executed in the authoring environment. Read [VALIDATION.md](VALIDATION.md) before enabling enforcement.

## Included implementation

| Area | Implementation |
|---|---|
| Bot | Gateway v10 ingestion, image-bearing edits, reconnect/resume, durable jobs, REST actions |
| Matching | Official Jev multipart image requests, strict Noul answers, pinned model, per-action thresholds, second verification |
| Rules | Individual, group, any-reference, explicit any-image; deterministic priority; one user sanction per message |
| Actions | Log only, review, delete, warn, timeout, kick, ban; optional delete alongside a user sanction |
| Activity | Overview, private image previews/uploads/bulk changes, graphical rules and tests, logs, permissions, settings, credential rotation |
| Security | Live Discord authority, delegated capabilities, guild isolation, encrypted write-only credentials, origin checks, bounded image decoding |
| Persistence | PostgreSQL migrations, private filesystem object storage, audit/evaluation records, persistent action ledger |
| Delivery | Docker/Compose, CI workflow, setup/security/API/operations guides, tests, synthetic evaluation fixtures |

### Deliberate stack choices

Node.js 22 and strict TypeScript; native HTTP, WebSocket, and browser DOM APIs; PostgreSQL (`pg`); native image normalization (`sharp`); the official Discord Embedded App SDK bundled with esbuild. No separate Redis server is required because jobs and idempotency records live in PostgreSQL. The Activity is native TypeScript rather than React. Jev uses its documented HTTP protocol directly rather than an additional SDK layer. These choices reduce runtime components, but the custom HTTP/Gateway code still needs independent review and live soak testing.

## Install and run

Requirements: Node.js 22.13 or later, npm, a PostgreSQL 16 database, a Discord application/bot, a TypeSafe account, and an HTTPS origin reachable by Discord's Activity proxy. Do not request the bot's Administrator permission.

```bash
cp .env.example .env
# Fill Discord credentials, database URL, public origin, and a generated master key.
npm install
npm run build
npm test
npm run migrate
npm start
```

The final two commands require a configured `.env` and a reachable database. Detailed application registration, Activity URL mapping, permissions, and onboarding are in [docs/SETUP.md](docs/SETUP.md).

**Dependency lock:** Registry access was unavailable during authoring. The committed `package-lock.json` was generated afterwards by a local `npm install`; it has not had a vulnerability or license review. Run those checks, then use `npm ci` for controlled builds. The bundled official SDK has not been resolved or executed here.

### Docker Compose

```bash
cp .env.example .env
# Fill .env. Use a generated URL-safe hexadecimal POSTGRES_PASSWORD.
docker compose up -d db
docker compose build app
docker compose run --rm app node dist/server/migrate.js
docker compose up -d app
```

Compose publishes the app/database on loopback only. Put an HTTPS reverse proxy in front of the app and set `PUBLIC_ORIGIN` accordingly. Use `NODE_ENV=production` for hosted operation. Compose is supplied, not deployment-tested. Run one active application process per database/bot.

## First-server workflow

Open the Activity from a guild, connect, select monitored text channels, and add a Jev API key under Settings. Upload a reference, create a rule, and test labeled matching/nonmatching samples. An administrator approves the current configuration before enabling automatic enforcement. New installations have no monitored channels and enforcement off. Kick/ban additionally require the high-impact switch and second verification. Closing the Activity does not stop the backend.

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
# Actual provider calls, charged to your key; not run during authoring:
TYPESAFE_EVAL_KEY=... npm run evaluate -- fixtures/manifest.json
```

The live evaluation command requires `.env`; set the evaluation key through your shell/secrets manager, not a committed file. The 32 synthetic cases are starting fixtures, not evidence of production accuracy. See [VALIDATION.md](VALIDATION.md), [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md), and [docs/MATCHING.md](docs/MATCHING.md).

## Project map

```text
activity/       Embedded UI source and styling
server/         Gateway, REST, API, worker, Jev, authorization, storage
shared/         Domain types, parsers, capabilities, defaults
db/             Explicit SQL migration
scripts/        SDK bundle, isolated preview, live evaluation/database helpers
tests/          Unit, native-decoder, HTTP, Gateway and worker tests
fixtures/       Original synthetic images and labeled evaluation manifest
evidence/       Actual local test output and offline browser screenshots
.github/        Proposed CI workflow
docs/           Setup, security, permissions, API, operations and acceptance
```

No user credentials, dependencies, or private Discord data are included. The source lives in the private repository [Jev-Engineering/TypeCheck](https://github.com/Jev-Engineering/TypeCheck); nothing has been deployed. `UNLICENSED` marks this private delivery; no unsolicited open-source license or third-party ownership assignment is imposed.
