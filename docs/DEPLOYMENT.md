# Production deployment

Production runs on GoDaddy Node.js Hosting. A release reaches it only through `.github/workflows/deploy.yml`:

PR → `Validate` and review → merge to `main` → `Validate` succeeds on the push to `main` → `Deploy production` deploys that exact commit → post-deployment verification.

## Architecture (verified 2026-10-16)

| Item | Value |
|---|---|
| GoDaddy app | `TypeCheck`, ID `NODEJS-mxa13say2y`, Node 22, attached to the Web Hosting subscription |
| Production URL | https://mxa13say2y.c24.airoapp.ai (GoDaddy platform hostname, TLS certificate issued by Google Trust Services) |
| Variants | PREVIEW (GoDaddy-login gated) and PUBLISH (production). An upload builds PREVIEW, and `deployment publish` promotes that build to PUBLISH. |
| Supported mechanism | `gddy hosting source upload` (zip) → `gddy hosting deployment publish`. There is no rollback API, so rollback redeploys a known-good commit. |
| Database | GoDaddy managed MySQL shared by PREVIEW and PUBLISH. Its `DB_*` credentials are injected into the runtime only: neither the dashboard ("no manual login") nor the API reveals them, so CI cannot connect to the database. The release backs the database up itself before migrating (see [Backups and restore](#backups-and-restore)). The dashboard's **Export SQL** is not a usable backup: it writes every JSON value as the text `[object Object]`, and its output fails to restore (verified 2026-10-17). |
| Edge / DNS | GoDaddy's own Cloudflare-fronted platform domain. The project's Cloudflare zones contain no record for this app, so there is nothing to change there unless a custom domain is adopted (see below). |
| Discord Activity | URL mapping `/` → production host. `https://1560495911358955540.discordsays.com/api/health` reaches the production process. |
| GitHub link | The app still shows `source: GITHUB` (`feat/mysql-store`) from initial setup. The `godaddy-node-js-hosting` GitHub App has `contents: read` and no webhook events, so pushes never trigger GoDaddy imports. The first zip upload replaces this source. |

### Why deployment cannot bypass CI

- The deploy job runs only for `workflow_run` events where `Validate` concluded `success` for a `push` to `main` from this repository. Pull request runs, other branches, failures and cancellations skip it.
- Manual dispatch must name a full SHA that is on `main` and has a successful `Validate` push run. The workflow checks both.
- Nothing else can deploy. GoDaddy has no push webhook, and the GoDaddy PAT exists only in the `production` environment, which is restricted to `main`.
- Limitation: the repository is private on GitHub Free, so branch protection and rulesets are unavailable (API returns 403). Review is a process requirement, not an enforced rule. A direct push to `main` still needs `Validate` to pass before it deploys, but skips review. Enforcing review requires GitHub Team/Pro or a public repository.

## GitHub configuration

Environment `production` (deployment branch policy: `main`):

| Kind | Name | Purpose |
|---|---|---|
| Secret | `GODADDY_PAT` | Dedicated GoDaddy PAT. Scopes: `hosting.application:read`, `hosting.source:read`, `hosting.source:write`, `hosting.deployment:execute`, `hosting.log:read`. No secret, database, domain or purchase scopes. This is the only secret. |
| Variable | `GODADDY_APP_ID` | `NODEJS-mxa13say2y` |
| Variable | `PRODUCTION_URL` | `https://mxa13say2y.c24.airoapp.ai` |
| Variable | `DISCORD_CLIENT_ID` | Public application ID, used to check the Activity proxy |

Application runtime secrets stay in GoDaddy (Settings → Environment variables, per variant) and are not managed by the pipeline: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `CREDENTIAL_MASTER_KEY`, `PUBLIC_ORIGIN`, `JEV_MODEL`, `ACCEPTANCE_APPROVED`. The `DB_*` values are platform-managed. Deployment never changes `ACCEPTANCE_APPROVED`, enforcement or high-impact settings. `MIGRATE_ON_START` stays unset: a release migrates only when the workflow marks it with `"migrate": true` in `release.json`.

To rotate the GoDaddy PAT, create a new token with the scopes above at https://developer.godaddy.com/personal-access-token. Then run `gh secret set GODADDY_PAT --env production -R Jev-Engineering/TypeCheck` (the value is read from a hidden prompt) and revoke the old token.

## What a release does

1. **Provenance.** The candidate must be a 40-character SHA on `main` with a successful `Validate` push run.
2. **Live release.** The workflow reads `/api/health` (`release`, `storage`). For releases that predate release reporting, it falls back to the newest successful GitHub deployment for `production`.
3. **Guard** (`scripts/release-guard.mjs`):
   - A candidate older than the live release is refused unless dispatched with `rollback: true`. For an automatic run this means a newer release is already live (CI runs finished out of order), so the run ends as a successful no-op (`superseded`).
   - A diverged history is refused.
   - Migrations are classified by diffing `db/`. *Expand-only* means new files that only create tables and indexes, and write rows only into those new tables or `schema_migrations`. Anything else (ALTER, DROP, UPDATE, DELETE, edits to shipped migrations) is *incompatible* and blocks deployment.
   - A forward release with an expand-only migration is marked `migrate`. Rollbacks never are.
4. **Record.** A GitHub deployment is created for the exact candidate SHA (`in_progress`). It links to the run.
5. **Ship.** `git archive` of the exact commit plus `release.json` (`commit`, `run`, `migrate`) is uploaded to PREVIEW, built by GoDaddy and then published. `migrate` is `true` only for an admitted expand-only forward release.
6. **Backup, then migration** (only when `migrate` is `true`). The release migrates itself at startup with the runtime's own `DB_*` credentials, because nothing else can reach the database. Under `GET_LOCK('typecheck:migrate')`, and only if a migration is still pending, it first writes a full backup from one consistent snapshot to `OBJECT_DIR/backups/<time>-pre-migration.sql`, then applies the migration and writes the version receipt last. PREVIEW and PUBLISH starting together therefore back up and migrate exactly once. If the backup fails, nothing is migrated, the release does not start, verification fails and the previous release is redeployed. PREVIEW starts the new code first while the previous release keeps serving on PUBLISH; expand-only schema is compatible with both. CI runs the same path on MySQL 8.0 before a commit is eligible (`scripts/test-backup-databases.mjs`): populate the previous schema, back up and migrate concurrently, restore the backup with the `mysql` client and compare every row byte-for-byte.
7. **Verify** (`scripts/verify-production.mjs`, read-only; up to 10 minutes for the release to appear, plus up to two 3-minute handoff retries):
   - HTTPS works.
   - `/api/health.release` equals the CI commit.
   - The storage marker is unchanged.
   - `/api/ready` is 200 (database plus controller).
   - API and unauthenticated responses are `no-store` and not edge-cached.
   - The page and its release-scoped assets load, and the Discord proxy serves the same release.
   - The published process becomes `leader`. If PREVIEW holds the lock, PREVIEW is restarted (at most twice) to hand over ownership. If PREVIEW still leads, the run passes with a warning: one controller exists, but it is the PREVIEW process.
   - For migration releases, the run reads the `database_migration` log line from GoDaddy's logs and shows the backup file, SHA-256, table and row counts, and variant in the summary. This is evidence only: a migrated release cannot have started without its backup.
8. **Failure handling.** Platform logs (secrets redacted) are kept as an artifact. If publishing had started, the previous release is redeployed the same way and verified. Rollback is automatic only because the guard admitted no incompatible schema change. The GitHub deployment is marked `failure`, and the run fails.

Concurrency group `production-deploy` serializes releases. A newer queued release replaces an older queued one. A running release, including its migration and cutover, is never cancelled.

## Controller ownership

PREVIEW and PUBLISH share the bot token and database, and the database leader lock elects exactly one controller (see SETUP.md). An upload restarts PREVIEW on the new code while PUBLISH keeps the lock. When PUBLISH restarts, PREVIEW can win the lock. The workflow detects this (`/api/health` reports `standby` on PUBLISH) and restarts PREVIEW, after which PUBLISH, retrying every five seconds, normally takes over. This is not guaranteed: a restarted PREVIEW can win again, and the run then ends with a warning rather than a rollback, because a healthy release with PREVIEW as controller is still a single controller. In that case restart PREVIEW again from the hosting UI or with `gddy hosting app restart --variant PREVIEW`. Duplicate controllers cannot occur, because the lock is held per database connection. To check manually:

```bash
curl -s https://mxa13say2y.c24.airoapp.ai/api/health   # {"status":"leader",...} expected
```

## Persistent storage

Reference images, the storage marker and pre-migration backups live in `OBJECT_DIR`. GoDaddy's File Manager states that the app directory (`/app`) is rebuilt from code on every deploy and that only `public/assets` and **Private Storage** (`/private`) are durable, so when `/private` exists and `OBJECT_DIR` is unset the app uses `/private/objects` (`defaultObjectDir` in `server/config.ts`). Releases before this change wrote to `./objects`, which deploys discard. Each process creates a random `.storage-id` marker in `OBJECT_DIR`, and `/api/health` reports it. The workflow fails a release whose marker differs from the pre-deployment marker, which means the storage was replaced. The first release on `/private` creates the marker, and later releases prove persistence. The File Manager shows the PREVIEW app's files; whether PUBLISH sees the same `/private` is confirmed by the marker matching across a release.

If a release reports a changed marker, the reference images from before that release are not on the new volume. Restore them from an object backup, or re-upload them through the Activity, before enabling enforcement.

## Cache behaviour

The GoDaddy edge forces `Cache-Control: public, max-age=2678400` on `.js` and `.css`, whatever the app sends. The page therefore references `/r/<commit[0:12]>/…` paths, so every release uses new module URLs. Clients cannot combine cached modules from different releases. The HTML page and all `/api` responses are `no-store` (`cf-cache-status: DYNAMIC`). No purge is needed or possible for the platform domain.

## Rollback

Reverting code does not revert schema. Every shipped migration so far is expand-only (`002_usage` only adds tables), and earlier releases ignore the added tables, so rolling back to any release since `001` is schema-compatible.

1. Find the last good commit: GitHub → Deployments → `production`, or a run summary.
2. Actions → *Deploy production* → *Run workflow*: `commit=<sha>`, `rollback=true`, `reason=<why>`.
3. The guard confirms that the target tolerates the live schema, then ships (never migrating), verifies and records.

Data written by the newer release stays in the database. For example, usage rows written to `usage_attempts` by a newer release are not shown by a release older than `002`, and they reappear when rolling forward. If a future migration is ever incompatible, the guard refuses both the automatic deploy and the rollback. That change then needs a maintenance window: pause enforcement, stop PREVIEW and PUBLISH, back up, migrate, deploy, verify, resume.

## Backups and restore

Each migration release writes `OBJECT_DIR/backups/<time>-pre-migration.sql` (mode 600) on the volume of the process that migrated; the run summary names the file, its SHA-256 and the variant. It is plain MySQL SQL: one `CREATE TABLE` per table, then one `INSERT` per row, with every value hex-encoded so JSON, text and binary data survive exactly. It contains guild settings and encrypted guild credentials, so keep any copy private.

To check a backup, download it from the dashboard's **Files** page (**Private Storage** → `objects/backups/`), compare its SHA-256 with the run summary, and load it into a disposable MySQL:

```bash
sha256sum 2026-…-pre-migration.sql
docker run -d --name restore-check -e MYSQL_ROOT_PASSWORD=local-only -e MYSQL_DATABASE=typecheck mysql:8.4
docker exec -i restore-check mysql -uroot -plocal-only typecheck < 2026-…-pre-migration.sql
docker exec restore-check mysql -uroot -plocal-only typecheck -e "SELECT version FROM schema_migrations"
docker rm -f restore-check
```

To restore production, load the same file with **Import SQL** (Settings → Hosted Database). It drops and recreates each table it contains; tables added by later migrations are left in place and the next release re-applies their migrations.

Restoring into production overwrites newer data and can replay moderation state. Follow OPERATIONS.md (pause enforcement, no Gateway until the action ledger is reconciled) and do it only as a deliberate incident action. Reference-image files are not in the SQL dump. The dashboard's **Files** page is the only way to copy them out.

## Manual operations

```bash
export GDDY_PAT=…            # same scopes as the CI token; never commit it
gddy hosting app status  --app-id NODEJS-mxa13say2y
gddy hosting deployment list --app-id NODEJS-mxa13say2y
gddy hosting log list --app-id NODEJS-mxa13say2y --variant PUBLISH --limit 100
PRODUCTION_URL=https://mxa13say2y.c24.airoapp.ai DISCORD_CLIENT_ID=1560495911358955540 node scripts/verify-production.mjs
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Deploy job skipped | Was `Validate` a successful **push** run on `main`? PR runs never deploy. |
| `no successful Validate push run on main` | Dispatch named an unvalidated or non-main commit |
| `candidate_older_than_live_release` | A newer release is live. Use `rollback: true` deliberately. |
| `migration_requires_maintenance_window` | The migration is not expand-only. Follow the incompatible-migration procedure above. |
| `release not serving` on a migration release | The release backs up before migrating. Check the PREVIEW log for `operational_error` during startup (for example a full or read-only volume); nothing was migrated. |
| `no database_migration log line found` (warning) | Platform logs lagged or rotated. The backup is still listed on the **Files** page → **Private Storage** → `objects/backups/`. |
| `AUTH_REQUIRED` from `gddy` | The PAT is missing one of the scopes above, or has expired |
| Import or publish `FAILED` | `deployment-diagnostics-<run>` artifact. GoDaddy build output is in the PREVIEW log. |
| `release not serving before timeout` | Startup failure on PUBLISH (for example `migration_002_required` or a missing secret). Check the PUBLISH log. |
| `object storage persisted` failed | The volume was replaced. See Persistent storage. |
| PUBLISH stays `standby` after handoff | Another process holds the lock. Check that only PREVIEW/PUBLISH use this bot and database. |

## Custom domain (not configured)

Production uses the platform hostname. Moving to a custom hostname on Cloudflare means:
- attaching the domain in GoDaddy (`gddy hosting domain attach`)
- adding the `_acme-challenge` CNAME and the A record GoDaddy returns, DNS-only first, then proxied with SSL mode Full (strict)
- cache rules that bypass `/api/*`
- updating `PUBLIC_ORIGIN`, the Discord Activity URL mapping and `PRODUCTION_URL`

That is a separate, user-approved change.
