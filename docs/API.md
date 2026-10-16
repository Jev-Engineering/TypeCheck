# Management API

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

Credential replacement: `{ "apiKey":"<new key>" }`. Credential deletion: `{ "revision":1 }`. No credential GET exposes plaintext or ciphertext.

Rule test: `{ "base64":"<image>", "expected":true }`. Test labels are server records, not browser-supplied confidence. Responses include `probability` (returned score), `ruleThreshold`, `actionFloor`, `effectiveThreshold`, `thresholdApplies`, `meetsThreshold`, `predicted` and `executed: false`. For reference rules, `meetsThreshold` uses score >= max(rule threshold, action floor). For any-image rules, `thresholdApplies` is false and `effectiveThreshold` / `meetsThreshold` are null. Approval: `{ "note":"At least 20 characters describing evidence and residual risks" }`.

Grant: `{ "capabilities":["images.view"], "revision":0 }` for a new grant; use current revision for replacement/removal. Review: `{ "status":"confirmed|false_positive|dismissed", "revision":1 }`.

## Error and pagination behavior

400 indicates invalid schema/configuration; 401 missing/expired session; 403 insufficient authority/origin; 404 missing guild-scoped record; 409 optimistic conflict/in-use record; 429 application budget/queue limit; 5xx operational/provider failure. Reload after revision conflicts. Never retry unknown Discord sanctions from a management client.

Event-family lists accept `q` and `before` ISO timestamp and return `items`, `nextBefore`, `totalRetained`; up to 100 rows per page. Filtering currently happens after loading retained guild rows. Timestamp-only pagination may skip rows sharing an exact page-boundary timestamp; use export/database inspection for exhaustive investigations. `/actions` is the durable forensic ledger, including unknown outcomes, not an action-retry endpoint. API JSON is authoritative; no generated OpenAPI client is included.
