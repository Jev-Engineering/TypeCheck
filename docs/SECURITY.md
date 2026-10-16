# Security design and deployment review

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

All applicable comparisons use Jev. Hashes support storage, calibration deduplication and request reuse, not a replacement identity model. Images may contain adversarial instructions; prompts explicitly treat them as visual data, but prompt wording is not a proof against injection. Threshold calibration and review-only deployment remain necessary.

## Moderation safeguards

Default enforcement is off. Numerical probabilities are not accuracy guarantees. Punitive actions need current approval. Severe actions require additional labeled examples, high-impact enablement and a second check; two calls to the same model are correlated, not independent evidence. One deterministic effective rule supplies a message's user-level action. Rules, source attachments, exemptions and relevant permissions are rechecked before dispatch.

The database commits an action claim before the Discord request. Network uncertainty is recorded as unknown and never automatically replayed. This prevents repeat attempts but can miss an action after a crash. Permissions may change immediately after a preflight; Discord remains the final authorization boundary. A pause cannot recall already-sent requests.

## Data lifecycle

Reference bytes live in a guild-scoped private content-addressed store. Submitted bytes are discarded after processing/testing. Pending jobs briefly retain signed attachment URLs; completed jobs erase their message payload. Successful/failed job rows expire after seven days. Logs, evaluations, audit and calibration rows expire according to the guild's 1–365-day setting. Orphan reference files are collected after at least 24 hours. Identifiers in seen-attachment and action-ledger tombstones persist to prevent replay; daily usage rows also persist. There is no self-service full guild-erasure UI in this release.

For complete guild removal, the application owner must stop processing that guild, remove its database guild row (cascading application records), delete its private object directory, and apply backup-retention policy. Document that process in the hosted service's privacy notice. Avoid retaining prohibited material you cannot lawfully possess; this candidate does not supply legal compliance review.

## Preproduction checklist

Review dependencies and freeze lockfiles/image digests; verify TLS/CSP/proxy handling; run live OAuth and revocation tests; run cross-guild database tests; test decoder limits under load; check backups and key recovery; verify crash/unknown-action handling; publish retention and provider-data notices; conduct independent security review. None of these is implied complete by local mock-based tests.
