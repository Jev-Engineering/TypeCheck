# Management API

## Optional data-use choices

Administrator-only `PUT /api/g/{guildId}/settings` accepts independent boolean
`value.typesafeReviewConsent` and `value.completeTechTrainingConsent`, with the
current `revision`. Both default to false for new and legacy settings. Partial
updates preserve the other choice; unchecking and saving withdraws permission.
Invalid booleans return 400 and stale revisions return 409.

Changes write a `data_use.consent_updated` audit entry in the same guild
transaction, recording actor, timestamp, previous/current values and
`noticeVersion: "2026-10-17.1"`. Audit records follow configured log retention;
current choices remain in guild settings. These settings do not change moderation
approvals, provider request bodies/headers, or content retention.

`typesafeReviewConsent` records local permission for TypeSafe to read and analyze
inputs/outputs to understand model issues and debug use cases, **not training**.
The [official announcement](https://typesafe.ai/blog/jev-1-14) shows “Help improve
TypeSafe models” under organization settings in the TypeSafe console. It applies
to everyone in that organization. The current [API reference](https://docs.typesafe.ai/api)
and [OpenAPI schema](https://api.typesafe.ai/openapi.json) expose no control for
that setting. The app cannot enable, disable or verify it; the API-key owner must
manage it separately, including when a local permission is withdrawn. Do not
present a local checkbox as proof of provider-side state.

`completeTechTrainingConsent` records permission for the service host,
CompleteTech LLC, to use processed server data for model training/improvement.
No training-data collection, export or training pipeline exists in this release.
A future pipeline must define and disclose its data scope and retention before
activation, respect current consent and affected people's rights, and comply with
provider agreements. A saved permission alone must never activate collection.
See the [privacy notice](../activity/legal/privacy.html).

## Cost analytics

All paths below are under `/api/g/{guildId}` and require live `dashboard.view` authority, except pricing PUT which requires owner/administrator authority. Cross-guild sessions are rejected. Pricing writes require exact Origin validation and create `pricing.updated` audit records in the same transaction.

| Method/path | Result |
|---|---|
| GET `/analytics/summary` | Currency-separated totals, coverage, tracking start and separate legacy subtotal |
| GET `/analytics/daily` | Daily buckets, each separated by currency |
| GET `/analytics/breakdown?group=model` | `model`, `purpose`, `verification` or `outcome` buckets; `summary` and `day` also accepted |
| GET `/analytics/attempts` | `{items,next}` with up to 100 attempts; `next` contains both `before` and `beforeId` |
| GET `/analytics/export` | One bounded CSV page; continue with `X-Next-Before` and `X-Next-Before-Id` headers |
| GET `/analytics/pricing` | Latest configured revision per model, including future-effective entries |
| PUT `/analytics/pricing` | Administrator-only revision-checked immutable pricing revision |

Reporting parameters: `range=today` (default), `7d`, `30d`, `mtd`, or `custom`. Custom requires `start=YYYY-MM-DD&end=YYYY-MM-DD`: UTC inclusive start and exclusive end. Maximum span is 90 days and the entire range must fall within the last 90 UTC calendar days including today. Invalid dates, duplicate/unknown parameters, unsupported groups/filters and unbounded pagination return 400. `limit` defaults to 50, maximum 100. Cursor ordering is `(startedAt,id)` descending; send both cursor fields unchanged, preserving filters/range. This is not a frozen export snapshot.

Optional filters: `model` (model identifier), `purpose=moderation|rule_test|credential_validation`, `verification=true|false`, `outcome=reserved|dispatching|success|failure|uncertain`. Summary and daily endpoints force their grouping after validating supplied parameters. Legacy totals are whole-range aggregates without model/purpose/outcome attribution and are never folded into detailed totals.

Reports contain `{start,end,trackingStart,partial,legacy,buckets}`. `partial` is true if the range begins before tracking, includes legacy reservations or has incomplete price/usage coverage. Each bucket includes `key`, nullable `currency`, `attempts` (reservations), `dispatched` (dispatch markers, not proven receipt), `successes`, `failures`, `pending`, `uncertain`, `unknownUsage`, `priced`, `covered`, `inputTokens` and `costMicros`. Token and monetary subtotals are decimal integer strings; cost units are millionths of a currency unit. Missing attempt usage/cost is null. Clients must label money Estimated, partial coverage Partial estimate, null rates Rate not configured, and null usage Usage unknown. Never sum currencies.

Pricing PUT example (illustrative operator input, **not an actual provider rate**): `{"model":"jev-1.14.0","revision":0,"currency":"USD","perMillion":"1.250000","effectiveAt":"2026-10-16T00:00:00.000Z","note":"Operator contract reference"}`. Revision 0 creates a model's first revision; later writes use the latest revision from GET. Conflict returns 409. Price is a decimal string with up to six decimal places. Effective timestamps require canonical millisecond UTC ISO format. Historical attempts retain their snapshots. See [COSTS.md](COSTS.md) for rounding, provenance, retention, effective dates, crash windows and exclusions.

Base path: `/api`. JSON request bodies, JSON error shape `{"error":"stable_code"}`. Use TLS in production. Guild routes require `Authorization: Bearer <app-session-token>` and current Discord authority; writes also require an exact allowed `Origin`. The Discord SDK's guild ID is not proof of membership.

## Session and health routes

| Method / path | Behavior |
|---|---|
| GET /config | Nonsecret application ID |
| GET /health | Process liveness only; not bot/database/provider readiness |
| POST /auth/start | Issue short-lived nonce; `{}` body |
| POST /auth/exchange | `{code, nonce, guildId}`; exchange via Discord, create guild session |
| POST /auth/logout | Delete the current hashed application session |

Successful exchange returns app session token, short-lived Discord access token for SDK authentication, authority and expiry. Never persist either response in logs. There is no OAuth refresh-token storage.

## Guild routes: `/g/{guildId}`

| Path | Methods | Required authority / purpose |
|---|---|---|
| /me | GET | Current effective authority |
| /meta | GET | Guild roles/channel metadata for authorized UI |
| /dashboard | GET | dashboard.view |
| /settings | GET, PUT | Read permitted dashboard/channel access; write administrator |
| /channels | PUT | channels.configure; narrow monitored/excluded lists |
| /pause | POST | enforcement.pause |
| /credentials | GET, PUT, DELETE | Administrator; GET is status only |
| /credentials/test | POST | Administrator; tests configured key with actual image request |
| /groups | GET, POST | images.view / images.edit |
| /groups/{id} | PUT, DELETE | images.edit; in-use group deletion blocked |
| /images | GET, POST | images.view / images.add |
| /images/{id} | PUT, DELETE | images.edit / images.delete |
| /images/{id}/content | GET | images.view; authorized JPEG bytes |
| /match-thresholds | GET | rules.view, rules.create or rules.edit; returns only existing action floors |
| /rules | GET, POST | rules.view / rules.create plus action-specific gates |
| /rules/{id} | PUT, DELETE | rules.edit / rules.delete plus action-specific gates |
| /rules/{id}/test | POST | matching.test; labeled sample, no sanctions |
| /rules/{id}/calibration | GET | matching.test |
| /rules/{id}/approve | POST | Administrator; current evidence/fingerprint required |
| /grants | GET | Administrator or restricted delegation authority |
| /grants/{roleId} | PUT, DELETE | Administrator or restricted delegation authority |
| /events, /evaluations, /audit, /actions | GET | logs.view; guild-scoped search/history |
| /events/export | GET | logs.view and logs.export; CSV |
| /events/{id}/review | POST | logs.view and rules.edit; label, optionally disable false-positive rule |

### Payload examples

Upload a reference: `{ "name":"Example", "groupId":null, "enabled":true, "base64":"<standard base64 image>" }`. Replace/edit a reference with the same metadata plus `revision`; `base64` is optional for metadata-only edits. Do not send a storage key or remote URL.

Create/update a rule through `{ "rule": { ... }, "revision": 1 }`, omitting revision for creation. Required rule fields are defined and validated in `shared/domain.ts`: name, type, referenceId, groupId, mode, action, timeoutSeconds, deleteMessage, priority, enabled, automatic, secondVerification and reason. Optional `threshold` defaults to 0.70 for creation and preserves the saved value on update when omitted. IDs for absent targets must be null. The server supplies identity, timestamps, guild and approval; unknown keys are rejected.

Settings writes use `{ "value": { ...settings }, "revision": 1 }`. A transition to enforcement enabled additionally requires `"acknowledgement":"ENABLE_AUTOMATIC_ENFORCEMENT"`. Use GET immediately before editing and retain the returned revision. Omitted settings and individual action floors preserve existing values. For example, `{ "value": { "thresholds": { "review": 0.75 } }, "revision": 1 }` changes only the review floor. Thresholds require finite JSON numbers from 0.5 through 1.0 inclusive; timeout <= kick <= ban. Invalid values return `match_threshold_must_be_a_finite_number_from_0.5_to_1.0`; reversed severity floors return `severe_threshold_must_not_be_lower`. See [matching defaults and compatibility](MATCHING.md#configurable-match-thresholds).

`thresholds.review` controls fallback human review (default 0.70 for new servers, formerly a hardcoded 0.5). Each threshold remains independently valid from 0.5 through 1, with the existing severe-action ordering constraints. Review may equal or exceed an action floor: the fallback band is empty when review is at or above the effective threshold `max(rule.threshold, thresholds[action])`. Action-qualified candidates retain precedence; `uncertain: "ignore"` only disables fallback, not explicit review rules. See [matching](MATCHING.md) for boundary and selection semantics.

Credential replacement: `{ "apiKey":"<new key>" }`. Credential deletion: `{ "revision":1 }`. No credential GET exposes plaintext or ciphertext.

Rule test: `{ "base64":"<image>", "expected":true }`. Test labels are server records, not browser-supplied confidence. Responses include `probability` (returned score), `ruleThreshold`, `actionFloor`, `effectiveThreshold`, `thresholdApplies`, `meetsThreshold`, `predicted` and `executed: false`. For reference rules, `meetsThreshold` uses score >= max(rule threshold, action floor). For any-image rules, `thresholdApplies` is false and `effectiveThreshold` / `meetsThreshold` are null. Approval: `{ "note":"At least 20 characters describing evidence and residual risks" }`.

Grant: `{ "capabilities":["images.view"], "revision":0 }` for a new grant; use current revision for replacement/removal. Review: `{ "status":"confirmed|false_positive|dismissed", "revision":1 }`.

## Error and pagination behavior

400 indicates invalid schema/configuration; 401 missing/expired session; 403 insufficient authority/origin; 404 missing guild-scoped record; 409 optimistic conflict/in-use record; 429 application budget/queue limit; 5xx operational/provider failure. Reload after revision conflicts. Never retry unknown Discord sanctions from a management client.

Event-family lists accept `q` and `before` ISO timestamp and return `items`, `nextBefore`, `totalRetained`; up to 100 rows per page. Filtering currently happens after loading retained guild rows. Timestamp-only pagination may skip rows sharing an exact page-boundary timestamp; use export/database inspection for exhaustive investigations. `/actions` is the durable forensic ledger, including unknown outcomes, not an action-retry endpoint. API JSON is authoritative; no generated OpenAPI client is included.

## Exact normalized-image evidence

Image create/replacement derives optional `hashVersion` server-side with `sha256`; caller-supplied hashes/versions are not trusted. Metadata-only updates preserve the stored version. Legacy references without it use Jev. Existing image and log capabilities/guild scoping are unchanged.

`Match.provenance` is `exact_hash`, `jev`, or `any_image` for new results; legacy records may omit it. Exact matches carry `probability: null`, `model: null`, `verified: false`, `referenceRevision`, `hashVersion` and `policyFingerprint`; they never carry a synthetic provider response. Both hash and new Jev evidence bind to a policy/reference revision. Content digests are not added to match records, public notices or provider ledgers. Existing authorized reference/calibration APIs retain their current fields.

Rule-test responses and evaluations include `hashComparisons`, distinct from reported provider tokens/attempts. Hash-only rule tests have `predicted: true`, `probability: null`; hash-only evaluations have `model: null`. Mixed evaluations retain each comparison's provenance. Failed evaluations may retain partial evidence and are never actionable. UI displays “Exact normalized-image match”, matched reference ID and decision reason in authorized event details. Review labels remain annotations, not execution commands. Consumers must handle nullable model/probability and must not price avoided calls.

Exact-hash rule-test summaries set `thresholdApplies: false`, `effectiveThreshold: null`, and `meetsThreshold: null`. Configured rule/action values remain visible but are not a numerical verdict on deterministic evidence. Jev summaries retain the Standard/Strict/custom effective-threshold fields.


## Content-analysis API

Rule POST/PUT accepts type content, null reference/group IDs, compatibility mode exact and a versioned content definition. Creation forces automatic enforcement off; edits clear approval. GET /api/g/:guild/content-presets requires rules.view. Tests accept optional context (maximum 2,000 characters), used only with server and rule opt-in. Responses include content evidence, thresholds, policy outcome and partial/unknown costs. Settings accept contentMessageContext (missing-only default false). See [schema and decision mapping](CONTENT_ANALYSIS.md).


### Activity session renewal

`POST /api/auth/renew` accepts `{accessToken, nonce, guildId}` with the same trusted-origin and one-use nonce checks as code exchange. The server validates the bearer token through Discord `/oauth2/@me`, including application ID, identify scope and expiration, then checks live guild membership and delegated authority. It issues a fresh 900-second application session; OAuth tokens are neither stored nor returned. The Activity keeps its OAuth token only in memory and renews after application session expiry, avoiding repeat SDK authorization while Discord remains authenticated. Expired OAuth credentials trigger fresh authorization with a new nonce. Connection attempts are serialized and errors identify setup, authorization, exchange, authentication or renewal with retry instructions. No refresh token is stored and no session lifetime or enforcement permission changes.


### Calibration sample sources

The Activity Test dialog accepts local files, a same-guild Discord message link, or guild image-library selections. All retain the expected-label selector and existing evaluation, quota and cost ledger. Approval still deduplicates by normalized SHA-256 with unchanged thresholds. Identical reference samples produce `exact_hash` and do not count toward approval; use content rules or non-identical references. Deterministic false positives still block approval.

`POST /api/g/{guildId}/rules/{id}/test` accepts exactly one of `base64`, `messageUrl`, or `imageIds` (1-20 UUIDs), plus optional boolean `expected` and `context` (up to 2,000 characters). Uploads retain the single-result response; message/library requests return `{results: [...]}`. Each result includes `calibrationNote` (an explicit `exact_hash` exclusion note or null). Library access also requires `images.view`; records and objects are guild scoped. Older normalization versions require re-upload.

Message URLs use HTTPS on discord.com, canary.discord.com or ptb.discord.com with `/channels/guild/channel/message`. Requests check live `matching.test` and requester View Channel + Read Message History with channel overwrites before fetching. Threads use parent-channel permissions; private threads additionally require live membership or Manage Threads. Errors include `message_wrong_guild`, `message_not_found`, `message_read_permission_required`, `message_has_no_supported_images` and existing download/normalization byte and pixel limits. A batch can stop on a failed attachment after earlier samples completed; completed calls remain charged and labeled samples remain deduplicated on retry. Supported attachments use Gateway download/normalization limits. Raw sample bytes and message text are not stored. Message text is not automatically supplied to content rules: the explicit posting-context field and configured context gates still apply. Required Jev calls are charged normally; the existing exact-hash shortcut does not call Jev.


## Historical image scanning

See [Historical scans](HISTORICAL_SCANS.md) for administrator scope selection,
review-only results, permissions, fixed cutoffs, shared quotas, recovery,
coverage exclusions, migration 003, privacy and validation instructions.

Administrator-only routes (normal guild session and Origin checks apply):

- POST /api/g/:guild/scans/preview: validate {channels: "all" | string[],
  exclusions: string[], from?: string | null, to?: string | null,
  budgets: {messages: number, images: number, requests: number}}; returns scope
  without starting work.
- POST /api/g/:guild/scans: same input; durable start. Pass the preview's
  cutoff as to to retain the reviewed upper bound.
- GET /api/g/:guild/scans: up to 100 retained, guild-isolated scans.
- POST /api/g/:guild/scans/:id/pause, /resume, /cancel: lifecycle controls.
- GET /api/g/:guild/analytics/summary?correlationId=:scanId: existing usage/cost
  report filtered to that scan. Normal date-window parameters apply.

No enforcement flag is accepted. Deferred responses include Retry-After and
nextAttempt; restarting does not reset a persistent cooldown.


## Native text moderation (October 17, 2026)

`GET /api/g/:guild/text-starters` requires rules.view. `POST .../text-starters/install` with `{}` requires administrator and installs disabled rules transactionally once. Text RuleInput uses type:text, mode:exact, null referenceId/groupId and a text definition (version:message-text-v1, preset, presetVersion:1, question, positive, negative, exceptions, contextRequirements, requirePromotion, configured). Creation/editing requires administrator; new/conversion rules force automatic:false. Maximum eight enabled text rules. settings.textModerationEnabled defaults false; textStartersInstalled is read-only. `POST .../rules/:id/test` accepts exactly one of text:string or messageUrl:string, plus optional expected:boolean (omitted means unlabeled/ambiguous). Links must be same-guild and currently readable. Returns status, probability, thresholds, verification, expected label, matches with digest evidence, inputTokens, policyOutcome and executed:false. No moderation occurs. Usage labels analysisKind:text. See [bounds and evidence](TEXT_MODERATION.md).
