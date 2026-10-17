# Optional data-use permissions

TypeCheck records two independent server permissions, both off for new servers
and legacy settings without these fields. Moderation does not require either:

| Setting | Purpose | What saving it does |
| --- | --- | --- |
| `typesafeReviewConsent` | TypeSafe/Jev analysis of inputs/outputs to understand model issues and debug use cases, not training | Records local permission only; provider state remains unknown |
| `completeTechTrainingConsent` | Possible model training/improvement by service host CompleteTech LLC | Records local permission only; no collection/export/training pipeline starts |

## Provider boundary

The [TypeSafe announcement](https://typesafe.ai/blog/jev-1-14) describes its review
opt-in and says those queries are not used for training. Its linked organization
settings image applies the choice across organization members. On 2026-10-17,
the [API reference](https://docs.typesafe.ai/api) and
[OpenAPI schema](https://api.typesafe.ai/openapi.json) documented inference and
model discovery but no supported read/write control for this setting.

TypeCheck cannot enable, disable or verify the provider setting. The API-key
organization owner manages it in the TypeSafe console. Guilds sharing an
organization may have conflicting local choices; a guild checkbox cannot resolve
that conflict. Local withdrawal does not override an organization opt-in, undo
past processing or guarantee deletion. Ordinary moderation processing remains
subject to provider terms. Per-guild provider enforcement would need a separately
verified supported control/isolation design before it could be advertised.

## Save, withdrawal and notice changes

Settings reads show persisted values. An owner/administrator explicitly saves the
two choices; partial API updates preserve omitted fields. Uncheck and save to
withdraw either independently. Every request checks live membership/authority,
guild/session scope and existing origin protections. Only booleans are accepted.

Consent transitions require both the current settings revision and the notice
version displayed by the client (`2026-10-17.1`). Missing/stale notice versions
and stale revisions return 409 with no mutation. Reload the page, review current
choices/notice and save again. Unchanged or unrelated saves do not renew consent.
This version check binds the client declaration; it cannot prove someone read
the notice or has authority over all affected people's data.

Material changes to purposes require a new explicit choice under a revised
notice. Do not silently reinterpret existing true values, treat continued use as
consent, or infer re-consent from a generic settings/setup save. A future change
must design that transition and its evidence before using data; the present
flags are not sufficient evidence for a future training system.

## Persistence, audit and retention

Both SQL stores hydrate missing JSON fields as false; no schema migration is
needed. A changed choice and `data_use.consent_updated` receipt commit in the
same guild transaction. Receipt fields are actor Discord ID, guild ID, timestamp,
both previous/current choices and server-validated notice version. No-op saves
create no consent-transition receipt. Receipts contain no raw content or secrets.

Existing audit cleanup applies: configured 1–365 days, default 30. Settings
persist independently until changed or guild data removal. After audit expiry,
current booleans cannot reconstruct who accepted which historical notice when.
This is deliberately bounded history for permission recording, not permanent
consent evidence, immutable records, a retention extension or deletion guarantee.
Deletion requests and backup limits need coordination with the actual service
host; these controls add no deletion pipeline or fixed deletion deadline.

## Other settings writers and future use

Portable moderation packs omit consent from exports and reject supplied consent
fields on import, including false. Imports preserve destination values. Channel
changes, pause, starter installation and agent onboarding must preserve choices;
setup-plan acceptance cannot grant data-use permission. No settings writer other
than an explicit consent transition may manufacture a consent receipt.

No choice changes moderation approval, retention, provider request bodies/headers,
raw-content minimization, scanning scope or member rights. No collection, data
export, dataset or training pipeline is included. A future pipeline requires a
separately authorized design for eligible data, affected people's authority,
purpose, retention, notice/version evidence, withdrawal/deletion limits and
provider agreements. Saving a flag cannot activate it.

## Verification

`npm run check`, `npm run build`, `npm test` include parser, authorization,
revision/notice, rollback and portable-policy regressions. With Docker available,
`node scripts/test-consent-databases.mjs` creates only its own disposable
PostgreSQL/MySQL containers and verifies the real HTTP/SQL path, reopening pools,
legacy JSON, independent transitions, failed-write rollback, races, audit cleanup
and isolation. CI runs `scripts/test-consent-persistence.mjs` against its isolated
databases with `TEST_DATABASE_URL` and `ALLOW_DATABASE_TESTS=true`; it never reads
production `.env`. Browser receipts must distinguish synthetic adapters from live
Discord/provider acceptance. See the issue #49 validation record for actual results.

Maintainer content/security review, a confirmed host contact/deletion process and
provider organization ownership remain operational review items. This document
does not supply legal approval or a compliance conclusion.

To repeat synthetic browser checks, build the application, start the existing
`scripts/pack-ui-server.mjs` harness with `PACK_UI_PORT=4193`, then run
`python scripts/consent-browser.py` using the already-installed `mcp/playwright`
Docker image. The harness uses temporary in-memory data and synthetic adapters;
stop only that harness when finished. Screenshots and results go to
`evidence/consent49/`. It is a local test harness, not a production service.
