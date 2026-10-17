# Estimated Jev input-token costs

Cost & Usage is guild-scoped operational accounting, **not a provider invoice**. It estimates only reported Jev input tokens. Hosting, storage, network, taxes, credits, output tokens and other charges are excluded. Failed, timed-out and malformed requests may still incur charges. There is no billing-account integration or currency hard cap; moderation decisions and permissions are unchanged.

## Attempt lifecycle

Every actual provider attempt gets a random UUID, and comparisons within an evaluation share a random correlation UUID. Credential validation, moderation and rule tests/calibration have separate purposes. A retry has its own UUID and zero-based retry number. Second verification is a separate comparison with its verification flag set. Reused comparisons do not create extra attempts. No user/message/attachment identifiers are needed for correlation.

1. In a guild transaction, reserve daily request quota and insert a `reserved` attempt with its requested model, mode, purpose, UTC start day and applicable pricing snapshot. A duplicate reservation UUID does not consume additional quota. Quota remains atomically enforced by `usage_daily`.
2. Persist `dispatching` before invoking HTTP. This records intent to dispatch, not evidence that the provider received or billed the request.
3. Read bounded response JSON and extract valid nonnegative safe-integer input usage independently of model/answer validation. Strict moderation validation still applies. HTTP errors can contain valid reported usage. Missing, invalid or unreadable usage stays null, never fabricated as zero.
4. Finalize that original UUID as `success`, `failure` (complete response but unsuccessful HTTP or invalid answer), or `uncertain` (network or incomplete response). Completion timestamps represent local observation, not an invoice timestamp. Update the original start day's token total and the attempt in one transaction. The first terminal result wins; replaying it after reconnect or an ambiguous commit does not add tokens again.

Persistence callbacks sit outside provider retry catches. Accounting writes retry at most three times with the same attempt ID; exhausted retries return `usage_accounting_unavailable`. They never cause another provider request or invalidate credentials. Provider errors remain separate. Earlier finalized comparisons survive a later evaluation failure; evaluation records are not the billing ledger.

## Crash windows and recovery limits

There is no exactly-once provider billing guarantee. A crash after reservation but before dispatch leaves a pending reservation. A crash after the dispatch marker, during HTTP, or after receipt but before a durable completion can leave a pending dispatch with unknown usage. Pending rows are retained across restart and are never replayed by analytics. They are intentionally not changed to terminal failures by a startup sweep, which could race another instance's in-flight request. The UI warns that old pending dispatches may have uncertain outcomes. Provider retries after network errors can themselves incur multiple charges.

If all completion-write retries fail, the response's usage may be lost and the durable row remains pending/unknown. No local response spool or provider-side reconciliation is implemented. Operators must investigate persistent accounting errors and pending rows. Completion writes do not include raw provider errors, bodies or credentials. Late callbacks beyond detailed retention fail with a missing attempt rather than re-crediting historical totals.

## Pricing and exact arithmetic

An administrator enters a currency code, a decimal input price per million tokens, effective UTC timestamp and optional source/note. There are **no default rates**. Record the contract or price-sheet reference and its date without secrets. A rate is an operator assumption; changing it does not change the provider's price.

Updates require the current model revision and create an immutable revision. The applicable snapshot is the greatest effective timestamp at or before the attempt start, breaking ties by highest revision. Future rates do not replace the currently applicable rate until effective; backdated edits apply only to new attempts. Historical attempt snapshots never change. GET pricing returns the latest configuration revision for each model (which may be future-effective), not a revaluation of usage. At most 100 configured models per guild are supported.

Prices accept up to nine integer digits and six decimal digits. Convert the price to integer millionths of the named currency. For each attempt calculate `floor((tokens * priceMicrosPerMillion + 500000) / 1000000)` with BigInt. This rounds half up to six currency decimal places per attempt. SQL stores and sums `DECIMAL(38,0)` cost units; JSON returns integer strings. Monetary formatting does not use floating-point accumulation. Tokens are safe integers per response and decimal integer strings in aggregated reports. Currency totals stay separate.

“Rate not configured” means no effective rate was available. “Usage unknown” means no valid token count was reported. A monetary total covering fewer than all reservations is a **partial estimate**. Reports include attempts, attempted dispatches, successes, failures, pending, uncertain, unknown usage, priced and fully covered counts. Aggregate reported tokens and cost are known subtotals, not estimates for missing observations. Explicit zero-token responses and explicitly configured zero rates remain distinguishable from missing data.

## Migration, legacy data and retention

Migration 002 adds `usage_attempts`, immutable `usage_rates`, a tracking-start marker and `usage_legacy`. It does not modify 001. It snapshots existing `usage_daily` totals as legacy aggregates and preserves those original totals for quotas. Legacy totals are displayed separately: no model, exact attempt times or historical costs are fabricated, and legacy rows are never added to detailed totals. On the migration day, legacy and detailed rows can coexist; the separate snapshot prevents double counting. Filtered reports still show the whole-range legacy subtotal because legacy has no filter dimensions.

Stop/drain old application versions during an authorized maintenance window before migrating; mixed old/new writers cannot provide complete attempt coverage. Run `npm run migrate` using the intended deployment configuration, then start the new version. PostgreSQL migration remains transactional under its advisory lock. MySQL uses its named migration lock, restartable `CREATE TABLE IF NOT EXISTS` statements, idempotent legacy inserts, and a final version receipt despite DDL auto-commit. An interrupted migration is resumed by rerunning the command. Startup requires receipt 002; optional `MIGRATE_ON_START=1` uses the same runner. Manually altered schemas are not repaired. This feature's tests never use a hosted database.

Supported reporting covers the last 90 UTC calendar days, including today. Custom starts are inclusive and ends exclusive; today ends at the next UTC midnight. Detailed attempts expire after 100 days; legacy and quota daily aggregates after 400 days. Cleanup is idempotent and safe for concurrent instances, with no read/delete/rollup race. It deletes old detailed rows, not supported-window estimates; reports aggregate the indexed attempt table in SQL. No detailed model/cost reporting beyond the supported window is offered. Pricing revision provenance and the tracking marker persist until guild deletion. Existing backup retention is separate.

## API and CLI scope

See [API.md](API.md) for range, breakdown and cursor formats. Analytics and CSV use `dashboard.view`; pricing mutations require an administrator, allowed Origin, revision and audit record. CSV exports one bounded page; use both returned cursor headers to continue. CSV formula prefixes are neutralized. The ledger contains no API keys, request bodies, image bytes, signed URLs, user IDs or message IDs.

The evaluation CLI still runs without a database. Its `evaluation-results.json` includes per-attempt outcomes, reported usage, retry/verification metadata and a safe failure code even if a later comparison fails. Optional `JEV_EVAL_PRICING` is a JSON object in the same pricing format (including model, revision, currency, perMillion, effectiveAt and note). No rate is inferred from production configuration. It uses the same exact calculation and labels estimates. CLI output is written at normal completion or caught failure, not a crash-durable ledger. CLI runs are never imported into a guild dashboard. Live evaluation still requires explicit authorization and an evaluation key; automated tests use only synthetic responses.


## Content-analysis costs

Questions batch per selected rule. Each attempt, retry and verification is counted once with rule IDs and correlation provenance; no per-question tokens are invented. Unknown usage and unpriced estimates remain explicit. See [limits](CONTENT_ANALYSIS.md#resource-use-and-costs). Paid evaluations require explicit authorization.

## Local non-email benchmark estimates

`scripts/prepare-kaggle-benchmark.py` prepares a first batch of 10,000 Jigsaw comments, deduplicated spam/legitimate images and 1,000 DISC21 comparison pairs. It requires Python with `requests`; it makes no Jev calls and downloads no email corpus. DISC21 members are fetched from the original archives with byte ranges and checked against ZIP lengths/CRCs. Published copy/spam labels remain proxies for the tool's stricter matching/scam policies, not independently adjudicated production labels.

All benchmark helpers use `BENCHMARK_ROOT` (default `G:/datasets-deleteme/typecheck`). The runner/reporter also use `BENCHMARK_RUN_ID` (default `20261017-non-email-v1`). Dataset manifests live under the root; receipts, status and reports live under `runs/<run ID>`. Keep these outside the repository. Do not commit downloaded data, result receipts or credentials.

Before a paid run, build and freeze `dist/server` and `dist/shared` as the run's `runtime/server` and `runtime/shared`, copy `package.json`, and provide the frozen runtime access to the matching installed dependencies as `runtime/node_modules`. The local run uses a Windows directory junction to the existing dependency directory. Record the source commit, lockfile and runtime hashes. Do not rebuild that snapshot while its worker is running. With the manifests and snapshot prepared, `node --env-file=.env scripts/kaggle-benchmark.mjs` requires `TYPESAFE_EVAL_KEY` and explicit `ALLOW_PAID_KAGGLE_EVALUATION=true` authorization. It never calls Discord or grants enforcement approval.

The runner durably appends per-attempt usage and per-case results, resumes completed cases without another provider call, and refuses automatic resume when an external attempt or its case result needs reconciliation. A single-writer lock prevents a duplicate controller. A `STOP` file in the run directory requests a checkpoint between cases. Limits are 15,000 attempts and a stop after 100 million reported input tokens; unknown usage cannot establish a dollar hard cap.

An optional run-local `pricing.json` supplies the pinned model, currency and decimal input price per million tokens. On October 17, 2026, [TypeSafe's website](https://typesafe.ai/) listed **USD 0.042 per million input tokens and free output**. This is a public list-price estimate, not verified account-specific billing. For example:

```json
{
  "model": "jev-1.14.0",
  "currency": "USD",
  "perMillion": "0.042",
  "outputPerMillion": "0",
  "source": "https://typesafe.ai/",
  "verifiedAt": "2026-10-17T00:00:00.000Z"
}
```

Replace `verifiedAt` with the actual observation timestamp and preserve the source/basis. New reservations snapshot the rate; completions retain their estimated cost. Previously unpriced receipts receive a separately identified retrospective estimate without rewriting those original receipts. Each attempt is rounded half up to six currency decimal places using integer arithmetic before summing. Retries count separately; known usage on failures counts too. Unknown usage and pending attempts make the total partial. Taxes, credits, account discounts and other charges are excluded.

`python scripts/summarize-kaggle-benchmark.py --watch` refreshes `report.json` and `costs.json` every 30 seconds, including totals and cost by modality. It reads receipts without an API key and makes no provider calls. Worker `status.json` also includes estimated spend when started with pricing configured. Price assumptions and original receipts remain distinct from the provider's invoice and the guild Cost & Usage ledger.

Offline checks run in CI: `node --test scripts/kaggle-benchmark.test.mjs` and `python scripts/benchmark_costs_test.py`. They cover resume behavior, pricing backfill, per-attempt rounding, retries, unknown/pending usage, preserved rate snapshots and model mismatch. No dataset download or paid evaluation runs in CI.


## Historical image scanning

See [Historical scans](HISTORICAL_SCANS.md) for administrator scope selection,
review-only results, permissions, fixed cutoffs, shared quotas, recovery,
coverage exclusions, migration 003, privacy and validation instructions.


## Native text moderation (October 17, 2026)

Native attempts use analysisKind:text in the same guild ledger with administrator rates, quota reservations, unknown outcomes, retries and verification costs. No applicable enabled text rules means no text request. Successful test tokens appear in results; Cost & Usage includes every attempt and unknown usage. Estimates are not invoices. Paid provider evaluations require separate authorization. See [resource bounds](TEXT_MODERATION.md).
