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

Create/update a rule through `{ "rule": { ... }, "revision": 1 }`, omitting revision for creation. Required rule fields are defined and validated in `shared/domain.ts`: name, type, referenceId, groupId, mode, threshold, action, timeoutSeconds, deleteMessage, priority, enabled, automatic, secondVerification and reason. IDs for absent targets must be null. The server supplies identity, timestamps, guild and approval; unknown keys are rejected.

Settings writes use `{ "value": { ...settings }, "revision": 1 }`. A transition to enforcement enabled additionally requires `"acknowledgement":"ENABLE_AUTOMATIC_ENFORCEMENT"`. Use GET immediately before editing and retain the returned revision.

Credential replacement: `{ "apiKey":"<new key>" }`. Credential deletion: `{ "revision":1 }`. No credential GET exposes plaintext or ciphertext.

Rule test: `{ "base64":"<image>", "expected":true }`. Test labels are server records, not browser-supplied confidence. Approval: `{ "note":"At least 20 characters describing evidence and residual risks" }`.

Grant: `{ "capabilities":["images.view"], "revision":0 }` for a new grant; use current revision for replacement/removal. Review: `{ "status":"confirmed|false_positive|dismissed", "revision":1 }`.

## Error and pagination behavior

400 indicates invalid schema/configuration; 401 missing/expired session; 403 insufficient authority/origin; 404 missing guild-scoped record; 409 optimistic conflict/in-use record; 429 application budget/queue limit; 5xx operational/provider failure. Reload after revision conflicts. Never retry unknown Discord sanctions from a management client.

Event-family lists accept `q` and `before` ISO timestamp and return `items`, `nextBefore`, `totalRetained`; up to 100 rows per page. Filtering currently happens after loading retained guild rows. Timestamp-only pagination may skip rows sharing an exact page-boundary timestamp; use export/database inspection for exhaustive investigations. `/actions` is the durable forensic ledger, including unknown outcomes, not an action-retry endpoint. API JSON is authoritative; no generated OpenAPI client is included.

## Exact normalized-image evidence

Image create/replacement derives optional `hashVersion` server-side with `sha256`; caller-supplied hashes/versions are not trusted. Metadata-only updates preserve the stored version. Legacy references without it use Jev. Existing image and log capabilities/guild scoping are unchanged.

`Match.provenance` is `exact_hash`, `jev`, or `any_image` for new results; legacy records may omit it. Exact matches carry `probability: null`, `model: null`, `verified: false`, `referenceRevision`, `hashVersion` and `policyFingerprint`; they never carry a synthetic provider response. Both hash and new Jev evidence bind to a policy/reference revision. Content digests are not added to match records, public notices or provider ledgers. Existing authorized reference/calibration APIs retain their current fields.

Rule-test responses and evaluations include `hashComparisons`, distinct from reported provider tokens/attempts. Hash-only rule tests have `predicted: true`, `probability: null`; hash-only evaluations have `model: null`. Mixed evaluations retain each comparison's provenance. Failed evaluations may retain partial evidence and are never actionable. UI displays “Exact normalized-image match”, matched reference ID and decision reason in authorized event details. Review labels remain annotations, not execution commands. Consumers must handle nullable model/probability and must not price avoided calls.
