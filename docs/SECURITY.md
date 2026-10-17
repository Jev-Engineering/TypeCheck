# Security design and deployment review

## Cost analytics privacy and integrity

Analytics reads and paginated CSV require live `dashboard.view`; rate mutations require an administrator, allowed Origin, optimistic revision and transactional audit record. Composite guild keys and bounded indexed SQL ranges isolate attempt data. CSV uses the existing formula-injection protection. The attempt ledger stores no API keys, request/response bodies, image bytes, signed URLs, user IDs or message IDs; correlations are random UUIDs. Pricing notes are operator metadata and must not contain secrets.

Detailed attempts have 100-day retention; quota/legacy daily aggregates have 400-day retention, supporting reports within the last 90 UTC days. Pricing provenance and tracking metadata persist until guild removal. Cleanup is safe across instances and does not alter leader election. This supersedes the older statement below that daily usage persists indefinitely. Unknown tokens remain unknown. Dispatch markers do not prove receipt or billing; see [COSTS.md](COSTS.md) for crash windows and the absence of exactly-once billing guarantees. Accounting errors never invalidate credentials by themselves. Estimated input costs exclude other charges and do not change enforcement.

## Trust boundaries

Untrusted inputs include posted images, image filenames/metadata, browser requests, client guild identifiers and model responses. Browser controls are not permissions. Every guild API request uses a hashed bearer session, verifies live membership with Discord, and derives capabilities from current roles and per-guild grants. Records and references are queried with guild IDs; composite database keys/foreign keys prevent cross-guild references. The same guild boundary is included as AES-GCM authenticated data for credentials.

The application owner still controls infrastructure, the bot token and encryption master key. This is application-level tenant isolation, not isolation from a malicious host administrator. PostgreSQL row-level security and separate encryption keys per tenant are not implemented.

## Secrets

Jev API keys are encrypted using AES-256-GCM with a fresh random IV and a separate 32-byte master key. Only owners/Discord administrators may validate, replace or remove them. Credential GET returns status metadata, not plaintext or encrypted payloads. Failed replacements leave the previous working key intact. Rotating a guild key needs no bot restart; provider revocation must be done separately at TypeSafe.

Submitted keys necessarily exist briefly in the administrator's password field and the browser's outbound request. They are not echoed back or persisted in browser storage. Existing keys are never retrievable by the client. Prevent analytics/request-body capture on credential routes; configure proxy and host logging to redact Authorization, OAuth tokens, bot tokens, request bodies and environment values. Application errors expose stable codes, not arbitrary exception text.

Do not change the master key in place: this would strand old envelopes. A KMS/key-versioned re-encryption migration is not included. To change it for a small installation, pause enforcement, remove configured guild credentials under the old key, back up state, install the new master key, restart, and have each administrator re-enter/validate their key. Retain the old backup/key only according to your protected recovery policy.

## Sessions and HTTP

Single-use, origin-bound five-minute nonces protect code exchange. App sessions are stored hashed with a 15-minute expiry; tokens stay in frontend memory. No localStorage or cookie authentication is used. Revalidate authority server-side even if the frontend navigation is stale. HTTPS is mandatory in production, mutation requests require an allowed Origin, and JSON bodies are bounded. The production server has no preview/dev authentication bypass.

CSP constrains scripts, styles, connections and framing; static delivery is an explicit allowlist and cannot expose `.env` or server code. CSV export neutralizes spreadsheet formula prefixes. User-visible strings are inserted as text nodes; warnings/log messages disable mass mentions. Reverse-proxy request-size/time limits and per-IP throttling should supplement application limits, especially for deployments receiving all traffic through one proxy address.

## Image safety

Attachment downloads accept HTTPS Discord CDN hosts and the exact event channel/attachment path. Redirects and arbitrary administrator-supplied download URLs are not accepted. Real decoding validates content. Original files are capped at 8 MiB and 24 million pixels; native decoding has two slots and a bounded waiting room. Only supported still formats normalize to stripped, orientation-corrected, 768-square baseline JPEGs. Animations, malformed files and SVG are rejected. Container memory limits provide another boundary; image decoding in a dedicated sandbox would add protection but is not included.

Compatible exact normalized-content hashes run before Jev; missing, incompatible or unequal hashes fall through to Jev. Hash equality is deterministic matching evidence, not execution authority. Images may contain adversarial instructions; prompts explicitly treat them as visual data, but prompt wording is not a proof against injection. Threshold calibration and review-only deployment remain necessary.

## Moderation safeguards

Default enforcement is off. Numerical probabilities are not accuracy guarantees. Punitive actions need current approval. Severe actions require additional labeled examples, high-impact enablement and a second check; two calls to the same model are correlated, not independent evidence. One deterministic effective rule supplies a message's user-level action. Rules, source attachments, exemptions and relevant permissions are rechecked before dispatch.

The database commits an action claim before the Discord request. Network uncertainty is recorded as unknown and never automatically replayed. This prevents repeat attempts but can miss an action after a crash. Permissions may change immediately after a preflight; Discord remains the final authorization boundary. A pause cannot recall already-sent requests.

## Data lifecycle

Reference bytes live in a guild-scoped private content-addressed store. Submitted bytes are discarded after processing/testing. Pending jobs briefly retain signed attachment URLs; completed jobs erase their message payload. Successful/failed job rows expire after seven days. Logs, evaluations, audit and calibration rows expire according to the guild's 1–365-day setting. Orphan reference files are collected after at least 24 hours. Identifiers in seen-attachment and action-ledger tombstones persist to prevent replay; daily usage rows also persist. There is no self-service full guild-erasure UI in this release.

For complete guild removal, the application owner must stop processing that guild, remove its database guild row (cascading application records), delete its private object directory, and apply backup-retention policy. Document that process in the hosted service's privacy notice. Avoid retaining prohibited material you cannot lawfully possess; this candidate does not supply legal compliance review.

## Preproduction checklist

Review dependencies and freeze lockfiles/image digests; verify TLS/CSP/proxy handling; run live OAuth and revocation tests; run cross-guild database tests; test decoder limits under load; check backups and key recovery; verify crash/unknown-action handling; publish retention and provider-data notices; conduct independent security review. None of these is implied complete by local mock-based tests.

## MySQL and controller election

MySQL uses InnoDB, binary identifier collation, composite tenant foreign keys, JSON consistency CHECKs, parameterized SQL, strict session mode and UTC timestamps. MySQL 8.0.16+ is required; MariaDB and older servers fail with `mysql_8_0_16_required`. Tested MySQL 8.0.46 accepts direct JSON CHECK expressions with retained delete actions. The only stored generated column is the role-grant uniqueness key. No `INSERT IGNORE` is used: FK, CHECK and truncation failures remain errors.

Guild transactions lock the ensured guild row. Leader election holds `GET_LOCK('typecheck:leader',0)` on a dedicated connection, checks ownership every five seconds, and treats errors/end/failed keepalive as lost leadership. Its session idle timeout is 120 seconds. Only the winner resets processing jobs and changes attempting actions to unknown tombstones. Migration holds a separate `typecheck:migrate` lock. Dedicated MySQL lock connections are destroyed after release or error so no named lock leaks into pooled work. The pool is limited to five connections per process, including its leader connection.

Non-leaders remain API-serving standbys. Lock loss stops local controllers and exits; queued work can recover on another process. This is the existing single-controller model, not a distributed lease with external fencing: an already-issued Discord request cannot be cancelled, and network partitions need live fault testing. PostgreSQL retains its advisory lock and original schema/test path.

Never log environment values, connection URLs, raw driver exceptions or private keys. `DATABASE_URL` takes precedence over `DB_*`; use only one intended configuration. `DB_SSL=1` verifies the certificate and host identity, including IP literals; `DB_SSL_CA` is a PEM trust certificate, never a private key. No hosted database connection or migration was performed during this change. The app-specific provider TLS requirement is still unknown.

Whole-guild removal has a MySQL-specific operational constraint: InnoDB checks `RESTRICT` immediately during cascading deletes. A direct guild deletion can fail when rules/images still reference groups or images. After stopping processing for the guild, use one transaction to delete its `moderation_rules`, then `reference_images`, then the `guilds` row; remaining records cascade. Keep all statements scoped by the same guild ID and commit before deleting its private object directory. This ordering was tested; the foreign keys were retained. There is no whole-guild deletion method in the Store/API.

## Hash matching boundary

Only server-derived compatible normalization hashes qualify. Eligibility and guild checks run before comparison; metadata edits cannot introduce a client-controlled hash version. Match evidence contains reference identity/revision and policy binding, not content digests. Access to reference metadata and events keeps the existing capabilities. Hash hits do not read credentials or enter provider usage ledgers. Partial failures retain evidence but cannot dispatch punishment. All approval, calibration, severe-action verification, protection, permission and deployment gates remain mandatory; unmet gates route exact evidence to review without a provider request. Legacy hashes are never automatically relabeled. Hash-only samples are not Jev calibration evidence.


## Content-analysis boundary

Posting context requires server/rule opt-in and is not retained in jobs or evaluation records. Evidence contains its digest, typed judgments and moderator policy. No extraction, URL visits or command execution is performed. Incomplete assessments cannot authorize punishment. See [privacy](CONTENT_ANALYSIS.md#context-and-privacy).


## Native text moderation (October 17, 2026)

Submitted text is transmitted transiently for configured opt-in rules or authorized tests. Jobs retain a digest; audits, evidence, usage, notifications and exports exclude raw submitted text. Policies/reasons/approval notes remain administrator configuration and must not contain real secrets. Trust separation, attribution and sufficient-context/promotion gates mitigate injection; failures and unavailable text require review. These safeguards do not certify model accuracy or injection resistance. Digests reveal equality. See [privacy, retention and downgrade constraints](TEXT_MODERATION.md).
