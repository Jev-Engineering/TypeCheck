# Operations and troubleshooting

## Runtime model

One Node process hosts HTTP, the Gateway connection and a serial worker. PostgreSQL holds queue/idempotency state. A dedicated session advisory lock selects the single active bot process; loss of that connection terminates the process. This is not a multi-shard/high-availability release. Do not scale replicas or run a separate worker against the same bot without redesigning and validating leadership, rate limiting and recovery.

`API_ONLY=1` is development-only and still uses real Discord authentication/REST. It is not an anonymous admin mode. Production rejects it. The isolated preview is a different script and is not copied into the Docker runtime.

## Health and monitoring

`GET /api/health` is liveness. `GET /api/ready` checks PostgreSQL connectivity and Gateway online state (development API-only mode checks PostgreSQL only); Docker health uses readiness. Neither proves Jev accuracy or successful moderation. Unexpected completion/failure of the background loops terminates the process; Compose can restart it. The dashboard shows bot connectivity, credential state, counts and daily usage. Collect structured operational codes from stdout/stderr, not raw bodies/tokens. Monitor queue backlog, database availability, gateway-offline duration, credential failures, unknown ledger outcomes and disk usage. Hosted metrics exporters, alerts and dashboards are not provisioned by this project.

No channels selected means no monitoring. Excluded channels override selected channels. Only image attachments in exact selected text/announcement channels are in the supported UI scope; threads/forums/embeds are not expanded. Server owners/admins are protected. Other bots/webhooks are ignored unless enabled, and webhook identities never receive user-level sanctions.

## Backups and recovery

Back up PostgreSQL, the private object volume and the master-key recovery material as a consistent set. Keep keys separate. Test restoring into an isolated environment with enforcement paused and no active bot token. Restoring an old database may lose action tombstones; do not reconnect it to production and replay events without reconciling actions performed since the backup.

On a normal restart, interrupted jobs become queued. Action claims left attempting become unknown and are not reissued. Jobs erase message payloads on completion. Already-seen attachments and action slots remain durable. This is intentionally at-most-once dispatch and can miss an action if the process dies between claim and send.

## Unknown or failed moderation

Read both moderation events and the Durable action ledger under Activity log. Compare message/user IDs with Discord's own audit history. Do not blindly retry unknown outcomes. A recorded failure can reflect missing permission, role hierarchy, a deleted message, a changed rule, disabled enforcement or network uncertainty. Corrections/undo are manual; the review UI only labels events and disables false-positive rules.

Pausing prevents new eligible dispatch where observed, but cannot cancel an HTTP request already sent. For a major incident, pause, revoke the bot's destructive permissions, stop the worker and investigate before resuming.

## Common codes

| Symptom/code | Check |
|---|---|
| No image events | Message Content intent/access, selected exact channel IDs, bot channel permissions, supported still attachment format |
| gateway_fatal_4004 | Bot token validity; rotate in Discord if compromised |
| gateway_fatal_4013 / 4014 | Requested/approved intents in the Developer Portal |
| calibration_approval_required | Test and approve current reference/rule/model configuration |
| high_impact_disabled | Explicit admin high-impact setting; do not enable without validation |
| protected_or_exempt_member | Owner/admin protection, exempt roles and current target membership |
| enforcement_paused / policy_changed | A concurrent pause/settings/reference/rule edit; no automatic replay |
| image_byte_limit / invalid_image | File size/format/animation/decoder validation |
| image_decoder_busy | Reduce concurrent uploads and inspect host memory pressure |
| jev_* / credential error | Key, pinned model, image schema, provider limits/status and daily request budget |
| revision_conflict | Reload the current record before editing |
| session expired / unauthorized | Reconnect the Activity; verify live roles |
| internal_error / database_pool_error | Inspect safe host/database diagnostics without logging credentials |
| another_active_worker_holds_lock | Stop the duplicate bot instance; do not forcibly erase leadership state |

## Deployment gates and scaling

Hosted releases, backups, migrations and rollback follow [DEPLOYMENT.md](DEPLOYMENT.md).

Run the provided SQL integration helper against a disposable database. Build and launch containers. Verify non-root object writes, retention and orphan cleanup, TLS/proxy headers, OAuth launch, intent approval, rate limits, runtime restarts and the action ledger against real services. Pin reviewed dependency lockfiles and container digests. The local Compose drill passed; hosted CI has not been run.

Limits are deliberately modest: up to 250 references/rules per guild, 100 groups, 1000 queued/processing jobs per guild, one serial worker, bounded provider/Discord queues and per-guild request caps. At higher traffic, logs must move to database-backed pagination/search, queues need admission/tenant fairness review, and image candidate reduction must be evaluated for false negatives. Do not treat the current caps as capacity benchmarks.

## Restore drill and operational limits

`npm run test:compose` performs an actual `pg_dump -Fc` / `pg_restore --exit-on-error` into a separate database, archives private objects while the app is stopped, restores into a fresh volume, and checks decryption with the test master key. See `scripts/test-compose.mjs` for the exact ordered commands. Backup/restore volume ownership is initialized explicitly; normal app runs remain non-root. This is local test recovery, not an off-host disaster-recovery certificate.

For hosting, schedule encrypted off-host backups of a quiesced DB/object pair, store key recovery material separately, document retention/RPO/RTO, alert on failures, and rerun restore drills on the actual target. Never start a restored production snapshot against Discord before reconciling post-backup actions; stale ledgers can permit duplicate sanctions. No backup scheduler or public TLS endpoint is provisioned by this repository.

Terminate TLS at an authorized proxy; forward to loopback port 3000, preserve the Origin and Authorization headers without logging them, enforce request/body/time limits, and restrict database exposure. Verify TLS chain/renewal, the Activity proxy mapping, CSP, unauthorized routes and live OAuth on that target. An HTTPS `PUBLIC_ORIGIN` does not prove TLS is deployed.


## Content-analysis operations

Additive versioned fields use existing PostgreSQL/MySQL JSON persistence; no SQL migration or saved-policy rewrite is needed. Disable content rules before rollback to older code. Cap failures suppress incomplete-message punishment. Preserve backups, retention and isolation. See [compatibility](CONTENT_ANALYSIS.md).


## Historical image scanning

See [Historical scans](HISTORICAL_SCANS.md) for administrator scope selection,
review-only results, permissions, fixed cutoffs, shared quotas, recovery,
coverage exclusions, migration 003, privacy and validation instructions.


## Native text moderation (October 17, 2026)

Inspect native text status/blocked reasons and request correlation without logging message content. text_empty_or_unavailable requires intent/4014 and channel-access checks, never a safe fallback. Pause enforcement when diagnosing uncertainty; preserve action slots/job identity. Recovery refetches IDs/digests; stale edits requeue current content; deleted sources cannot punish. Historical scans remain image-only. Starter deletion is permanent. Before older-code downgrade, follow [JSON compatibility procedure](TEXT_MODERATION.md). Production publication requires separately authorized manual workflow dispatch after main CI.

## Pack persistence and recovery

Migration 004 adds `pack_definitions` and `moderation_packs`. Include these tables in database backups/restores alongside existing reference rows and the private object volume. Pack exports deliberately omit credentials, audit/history, jobs and action/usage ledgers and cannot replace operational backups. Preserve import receipts to retain repeat-import baselines and deletion tombstones. Older seeded guild recognition uses the retained seed audit event; missing historical receipts/events limit deletion recognition, as documented in [packs](MODERATION_PACKS.md).

Database transactions protect policy, references, grants and receipts on both backends. Filesystem objects are content-addressed and written durably before their row is committed. A crash or rollback can leave safe orphans; existing hourly leader collection removes unreferenced files older than 24 hours. Failed import also attempts conservative collection. Do not manually delete shared/young objects. Preview MACs are purpose-separated and shared across replicas using the application vault key; expiry or key rotation requires a new preview. This does not justify restarting WSL or other shared workloads.
