# Management API

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
