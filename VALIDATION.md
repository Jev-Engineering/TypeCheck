# Implementation and validation record

Prepared October 15, 2026. Candidate version: 0.1.0. This record distinguishes source implementation, local execution evidence, and external acceptance.

## Executed locally

| Check | Actual evidence | Scope |
|---|---|---|
| TypeScript compilation | `evidence/typecheck.txt` | All server, Activity, shared and test TypeScript compiled using the available compiler |
| Automated tests | `evidence/local-tests.tap` | 142 passed; zero failed, skipped, or cancelled |
| HTTP/security | Included in the 142 | Real loopback HTTP server with test persistence, mocked Discord and Jev |
| Image decoding | Included in the 142 | Real local sharp decoder and filesystem; malformed input, bounds and isolation |
| Gateway protocol tests | Included in the 142 | Synthetic WebSocket events, identification intents, heartbeat sequence, image-only ingestion |
| UI browser checks | `evidence/browser-smoke.json` | Six screens and a rule dialog at desktop and mobile widths: 14 checks |
| UI visual inspection | `evidence/preview-*.png` | Offline sample data; no live Activity connection |

Tests use an in-memory Store implementation, fake Discord identities/actions, and explicitly controlled Jev responses. Their success does not establish PostgreSQL behavior, API compatibility in a live account, or visual matching accuracy. The browser environment blocked loopback navigation; the browser checks render compiled UI with isolated synthetic SDK/fetch boundaries and no network. The production frontend is not replaced with this fixture transport.

The native decoder available for authoring was sharp 0.34.1; the declared install range begins at 0.34.4. Local Node type declarations were 25.1.0, whereas the package requests the Node 22 type line. Re-run all tests against the actual resolved dependency graph. Environment details are in `evidence/environment.json`.

## Blocked or not executed

- **Dependency installation and full browser bundle:** npm registry DNS access was unavailable. TypeScript compilation succeeded, but `npm run build` stopped at missing esbuild. The official Embedded App SDK bundle and a clean install remain unverified. See `evidence/build-attempt.txt`.
- **PostgreSQL:** No PostgreSQL server/driver was available locally. SQL migration and `scripts/test-postgres.mjs` were written, not executed. The provided CI workflow has not been run.
- **Docker:** No Docker build, image pull, container startup, persistent-volume recovery, or deployed health check was executed.
- **Discord:** No application registration, intent approval, real OAuth, Activity launch, reconnect soak test, role mutation, or real moderation action was performed.
- **Jev:** No key was available or requested. No real comparisons, authentication checks, threshold calibration or accuracy measurements were performed.
- **Public hosting/security:** No TLS proxy, penetration test, load test, secrets-manager integration or independent security review was completed.

## Implemented candidate, not completed acceptance

All primary components contain executable application code, not placeholder handlers that report success. External failures do not fabricate matches or successful sanctions. Nevertheless, the source specification's end-to-end completion criteria remain open until the real deployment/provider tests pass. See the acceptance matrix for precise differences and manual gates.

## Important limitations

This is a single-worker/single-shard, modest-volume candidate, not a horizontally scaled moderation platform. No thread/forum traversal, historical-message backfill, animated image extraction, video analysis, arbitrary image URLs, stickers or embeds are processed. The normal channel picker covers text and announcement channels. Missing an event during an unrecoverable Gateway gap is possible.

Reference images use private local filesystem objects, not S3. Posted image bytes are transient and never retained for history thumbnails. Logs show identifiers, matches and reference metadata; ordinary retained records expire, while minimal idempotency/action tombstones remain until guild deletion.

Partial matching is a Noul decision, not a Box localization feature. Semantic matching is disabled by default and is review-only when enabled. Optional repeat-offender escalation and a mandatory two-administrator rule-change approval workflow are not implemented. Approval is a single administrator's attestation against labeled examples. False-positive review disables the rule but does not undo a timeout, kick, ban or deletion.

Bulk changes are sequential and can partially succeed. Log filtering loads retained rows before paginating; database-backed cursor/search and large-library candidate retrieval are future scaling work. An image that fails to decode/evaluate suppresses the whole multi-image enforcement decision. This prioritizes avoiding uncertain sanctions over perfect detection availability.

Action delivery is **conservative at-most-once dispatch**, not exactly-once execution. A crash after a durable claim can suppress an action that never reached Discord. A lost response becomes unknown and is not retried automatically. Review the action ledger and Discord records manually. Pausing prevents subsequent dispatch where observed; it cannot cancel a request already sent.
