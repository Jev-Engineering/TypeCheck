# Historical image scans

Administrators can open **Historical scans** in the Activity, choose all eligible
channels or a selection, exclude channels, enter an optional date range, and set
message, image and provider-attempt budgets. Preview displays the scope and
permissions before Start. The preview cutoff is passed back on Start; Start
rechecks permissions and configuration. Dates entered in the Activity are local
time and stored as UTC. The lower date is inclusive and the upper cutoff is
exclusive. Messages created after that cutoff are outside the scan.

Only guild text and announcement channels are supported. All threads (including
archived and private threads), forum/media posts, DMs and other containers are
excluded. The report lists channel exclusions and always identifies the thread
coverage gap. A traversal of every selected channel therefore ends as
`completed_with_gaps`, never a claim of complete server coverage. If no selected
channel can finish, the scan is `failed`. An image failure leaves a gap even if
pagination reaches the end of that channel.

Historical scanning is **review-only**, including when automatic live enforcement
is enabled. There is no historical enforcement opt-in in this implementation.
Review confirmation does not execute a moderation action. Existing live policy,
approval, verification, exemptions and action-ledger behavior remain applicable
to Gateway jobs. Historical scans do not mark live attachments as already moderated.

## Permissions and configuration

The requester must remain an owner or Discord administrator. Both requester and
bot need View Channel and Read Message History. An online Gateway with the
configured intents (Guilds, Guild Messages and Message Content) must have been
established; a short-lived leader health receipt supports requests served by a
standby. Execution defers while the leader's Gateway is offline.

Preflight requires active rules and a validated provider credential. Even a
hash-only scan requires this preflight, but compatible exact hashes bypass Jev.
Server exclusions, bot/webhook preferences, protected members and exempt roles
are respected. The scan uses selected channels independently of the live
monitoring channel list. Settings, rules, references and encrypted credential
identity are fingerprinted. Changes pause the scan; start a new scan to use the
new configuration. Permissions are refreshed before each message/attachment,
each provider attempt and before recording successful evidence.

## Progress, budgets and recovery

Pause stops new work; Resume retains the original cutoff and cursors. Cancel is
terminal. An already-dispatched request may finish: its accounting and evidence
are retained without resuming cancelled work. Progress includes messages visited,
supported image attempts (including failures), detected rule matches, skipped and
failed items, reused results and conservative request reservations. Detailed
failure samples are capped at 100; total failure counts are not capped.

Message, image and request ceilings are finite (1 through 1,000,000). There are
at most five nonterminal scans per guild and 500 channel entries per scan. A
budget-paused scan requires explicit administrator intervention. Once a scan's
own ceiling is reached, start another scan; successful same-policy results are
reused. Daily guild quotas reset at UTC midnight; Resume may be used after reset.
The UI lists up to 100 retained scans, with active eligible scans first.

The elected worker services at most eight live jobs before a historical turn,
and otherwise gives idle time to scans. Ready scans rotate by their next eligible
timestamp. Each turn retrieves one message, advances a checkpoint, or evaluates
one attachment. At most one new provider attempt runs per historical turn;
completed comparisons are durably cached for later rules/verification. There is
no additional scan controller or historical jobs queue. A pending message's IDs
are committed before evaluation; its channel cursor advances only after all
attachment outcomes are recorded. Restart resumes that pending state.

Long cooldowns are persisted and release the worker. Provider/CDN/Discord
transient failures have a three-response retry budget per historical item;
waiting on an already-known shared cooldown does not consume it. Temporary
network failures use bounded exponential backoff with jitter. Unavailable
messages, removed/edited attachments and unsupported images are recorded as gaps.
Invalid provider credentials pause scans and prevent repeated provider calls
until revalidated or replaced. Discord token authentication failures block the
token's scheduler scope until the token changes.

Successful results deduplicate by guild, message, attachment, edit timestamp and
policy/reference fingerprint. A new scan under the same revision reuses them;
there is no force-rescan flag. New policy/reference revisions create fresh work.
Deterministic evidence IDs and durable receipts cover a crash after evidence
write but before cursor advancement. Live and historical work may both evaluate
an attachment, but historical work cannot dispatch an action and the existing
live action ledger remains the action deduplication authority. An external
request whose outcome was lost can be retried; exactly-once provider execution
is not promised, and its reservation remains visible.

## Shared limits and accounting

All runtime Discord REST calls use the same persistent scheduler, including
live actions and scan preflights. It learns bucket IDs, retains major parameters,
honors remaining/reset headers and route/global 429s, and parses Retry-After
seconds, HTTP dates and body `retry_after`. The local waiting room is capped at
64. DISCORD_MIN_INTERVAL_MS defaults to 40 (configurable from 20 to 100). This admission interval is a conservative deployment ceiling, **not** a
claim that Discord has one universal route limit. Short admission waits are
bounded to 100 ms; longer delays return a durable deferral.

Jev calls from moderation, scans, rule tests and credential validation all pass
through `Services.call` and its attempt ledger. Credentials shared across guilds
share a hashed credential limiter. A conservative deployment-wide account scope
also serializes different credentials and shares cooldowns and daily reservations.
`JEV_ACCOUNT_SCOPE` names that scope (default `deployment`); all processes using
the same provider account must use the same scope and database. Do not use
different scope values to work around provider quotas.

- `JEV_MIN_INTERVAL_MS`: default 1000, configurable from 0 to 3,600,000.
- `JEV_DAILY_REQUEST_LIMIT`: default 1000 deployment/account reservations per UTC
  day, configurable from 1 to 10,000,000. Existing per-guild daily quotas also apply.
- One provider request is in flight per account scope. Persistent leases are
  bounded, ownership-fenced and released after completion; a crash can delay the
  next admission until lease expiration.
- Provider Retry-After and retry-after-ms, 429/529 and retryable 5xx responses
  defer work; authentication and validation errors are not retried.
- Discord CDN downloads share persistent cooldowns and one download admission
  across runtime callers. Existing 8 MiB / 24-million-pixel normalization limits,
  two decoder slots and the bounded decoder waiting room remain enforced.

Reservations occur before dispatch, including retries and required verification.
A scan reservation can exist without a dispatched provider request (for example,
a daily quota rejection or crash). **Scan usage and cost** reads the existing
attempt ledger filtered by scan correlation ID: it distinguishes reservations,
dispatches, failures, pending/uncertain outcomes and reported tokens. Unknown
usage and missing pricing are not zero-cost calls. Estimates use existing rate
snapshots and are not provider invoices. Failed attempts with reported usage
remain included. Usage queries retain the existing 90-day reporting window.

Official documentation checked on 2026-10-17:

- [Discord rate limits](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)
  specifies response-driven route buckets, major parameters and global limits.
- [TypeSafe API](https://docs.typesafe.ai/api) specifies backoff for 429 and 529.
  The `.md` endpoint failed to load; the official HTML reference was available.
- [TypeSafe retry policy](https://docs.typesafe.ai/sdk/python/api/retries)
  documents bounded retries, exponential backoff and retry headers.

No numeric provider request-per-minute or token-per-minute account entitlement
was verifiable in those official references. The configurable ceilings above are
local operating policy, not published Jev quotas. Response-driven throttling
still applies. Token usage is reported, but no unverified numeric token quota is
invented. Confirm account-specific entitlements with TypeSafe before increasing
deployment ceilings.

## Storage, privacy and validation

Migration `003` adds `durable_work` for both PostgreSQL and MySQL. Migrate before
starting this build; the startup schema check requires `003`. Existing deployment
backup and migration gates still apply. No production scan or deployment is part
of implementation validation.

Scan persistence contains IDs, fingerprints, counters and bounded error samples,
not signed attachment URLs, posting text or posted image bytes. Existing content
rules may use the current posting message only under their existing explicit
context consent. Provider comparison caches contain typed answers and usage, not
image data. Evidence is guild-isolated. Guild deletion cascades to scan/cache
records. Guild-bound scan/cache records expire under `logRetentionDays`, including
paused scans; they must not be treated as permanent archives. Expired scans cannot
be resurrected by a late worker checkpoint. Account cooldowns and quota records
have no guild-private content; expired inactive records are cleaned after seven days.

Run `npm test`, plus `scripts/test-historical-persistence.mjs` with
`ALLOW_DATABASE_TESTS=true` and an isolated loopback `TEST_DATABASE_URL` for each
database. CI runs the historical persistence drill on both database services.
The synthetic-history test generates messages lazily and asserts bounded scan
state and no history queue growth. Real Discord/Jev acceptance still requires an
explicitly authorized test guild and provider budget.
