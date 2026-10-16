# Setup and server onboarding

## 1. Register the Discord application

Use the official Developer Portal and current Activity guide [D1]. Create one application with a bot and an Activity. Record the application ID, OAuth client secret and bot token in the host's secret configuration. Do not put these values into the Activity code or a repository.

Enable the Guilds, Guild Messages and privileged Message Content intents. The implementation requests these three intent bits only. Message Content access is necessary for attachments; verified applications may need approval [D2]. A connected bot without attachment access is not an accepted installation.

Configure a Guild Install with the `bot` scope and Activity launch capability appropriate to the current portal. Enable Activities and its launch/Entry Point configuration. Use Discord's provided launcher behavior for the initial deployment; the project does not implement a custom interaction webhook or slash-command launch handler. Follow [D1] if the portal requires an application-command scope or Entry Point setup for your installation.

## 2. Permissions and hierarchy

Select only permissions needed by enabled features: View Channels and Read Message History for monitored channels; Manage Messages for deletion; Moderate Members for timeouts; Kick Members and Ban Members only when used. Send Messages is needed for warnings and configured log notifications. No bot Administrator permission is required. Place the bot's role above members it must sanction, and validate channel overwrites. Protected users/actions remain subject to Discord restrictions [D3].

The application deliberately exempts guild owners and administrators from automatic moderation even where a particular Discord operation might otherwise be allowed. Other exemptions are configurable.

## 3. Configure backend and storage

Copy `.env.example` to `.env` for local use. Generate the encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set `CREDENTIAL_MASTER_KEY` to this value. Back it up separately from database/object backups; losing it makes existing Jev credentials unreadable. Set `DATABASE_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `PUBLIC_ORIGIN` and `OBJECT_DIR`. For Compose, generate a URL-safe password, for example `randomBytes(24).toString('hex')`, and set `POSTGRES_PASSWORD`.

Run `npm ci`, `npm run check`, `npm run build` and `npm test`; provision PostgreSQL or MySQL and run migration 001 before starting the application. Keep `ACCEPTANCE_APPROVED=0` until the documented live and independent acceptance gates pass. The runtime creates schema only when explicitly configured with `MIGRATE_ON_START=1`. Run the database integration helper against a dedicated disposable database before accepting the deployment.

A local private object volume must be writable by the app user and backed up with the database. It must never be exposed as a public static directory. The HTTP endpoint authorizes each reference-image read.

## 4. Host the Activity over HTTPS

Provide a TLS reverse proxy for the application's port 3000. Set `NODE_ENV=production` and the exact HTTPS `PUBLIC_ORIGIN`; do not include a path. Configure root `/` in the Discord Activity URL mappings to this host, so the frontend, `/api`, compiled modules and SDK bundle are reachable through the Activity proxy [D4]. Register the OAuth redirect URI required by the current Developer Portal/guide. This code follows the SDK authorize flow, not a conventional browser redirect callback route.

The SDK obtains an authorization code; the backend exchanges it and verifies the Discord identity. The bot fetches guild membership/roles independently. Client-provided guild context is merely a requested scope, never proof of access. The Discord access token is returned once for `authenticate`; application sessions are separate memory-only bearer tokens with a 15-minute server-side expiry. Use Reconnect after expiry.

The backend allows only the configured public origin and the exact application `discordsays.com` origin. Keep these rules intact; do not replace them with wildcard CORS or trust arbitrary forwarded-host headers.

## 5. Configure a server

Launch from a server, not a direct message. The owner or a Discord administrator can configure the app immediately; a role named Moderator has no automatic authority.

Under Settings, select exact monitored text/announcement channels. Exclusions win. Set role exemptions and a private log channel. Validate the Jev key through the Activity; this sends a small image-capable validation request and may incur usage. The existing key is retained if replacement validation fails.

Upload references and create individual/group/library rules. Choose an explicit matching mode, threshold, action, duration and priority. Run positive and negative labeled tests. Administrators approve the exact configuration and then enable enforcement. Kick/ban require a separate high-impact opt-in. A reference, model, threshold or rule change makes dependent approvals stale.

Test initially with logging/review. Use consenting test accounts in a private server when checking destructive actions; verify both bot and target roles and inspect Discord's own audit log. Keep a human administrator present and use the pause control during troubleshooting.

## 6. Delegate moderator access

Use Permissions to grant capabilities to specific roles. Read-only, image-management and policy-editing roles can differ. Credentials, security settings and unrestricted permission management remain administrator-only. Role changes are checked on the server on each authenticated request. See PERMISSIONS.md.

## Reference keys

[D1] https://docs.discord.com/developers/activities/building-an-activity

[D2] https://docs.discord.com/developers/events/gateway#message-content-intent

[D3] https://docs.discord.com/developers/topics/permissions

[D4] https://docs.discord.com/developers/activities/development-guides/networking

Official documentation consulted October 15, 2026. Portal UI and approval processes can change; recheck before installation.

## Repeatable isolated deployment validation

Run `npm ci`, `npm run build`, then `npm run test:compose` with Docker Compose 2.24.4+ (override tags required). This uses `tests/compose.env` with public disposable values, never your `.env`, and disables Gateway/worker startup. It builds the official image, tests PostgreSQL, exercises outage/restart/backup/restore and removes only its containers/network. Dedicated test volumes remain for inspection. `VALIDATION_SUBNET` may select an unused private subnet if the default 10.253.215.0/28 conflicts; inspect existing networks/routes first. Do not prune shared resources.

Live setup belongs in the ignored `.env`: test application credentials, test guild/channel/consenting users, explicitly permitted actions, authorized HTTPS origin, TypeSafe evaluation key and labeled corpus manifest path. Never use a production database. No browser setup agent should start a second bot controller.

## GoDaddy managed MySQL deployment

The public [GoDaddy hosting contract](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/contract.md) (consulted October 16, 2026) specifies `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, production-only dependency installation, and a subsequent build/start. Build tools are pinned in dependencies so that this pipeline can compile the application; `.npmrc` selects the public npm registry. A clean production-only install/build was verified locally, not on GoDaddy.

For the separately authorized deployment of app `NODEJS-mxa13say2y`:

1. Verify Settings â†’ Hosted Database â†’ Open database guide, the actual server version (MySQL 8.0.16+), and TLS requirements. The app-specific guide and hosted server version were not available in this run. The local `.env` contains a loopback PostgreSQL URL, not hosted database credentials. Never use the hosted database for tests.
2. Point the app at `feat/mysql-store`; use its build and start scripts. Supply Discord credentials, public HTTPS origin, a backed-up master key and database credentials through the hosting secrets UI yourself. Either supply a percent-encoded `mysql://user:password@host:port/database` URL, or omit `DATABASE_URL` and use the platform's five `DB_*` variables. An existing `DATABASE_URL` takes precedence. Do not upload `.env`.
3. If TLS is required, set `DB_SSL=1`; supply the provider's PEM CA as `DB_SSL_CA` if it is not publicly trusted. Certificate chain and hostname/IP identity verification stay enabled. URL query options are rejected; configure TLS through these dedicated variables. TLS does not default on without verified provider requirements.
4. For an authorized first boot only, set `MIGRATE_ON_START=1`. The process acquires the migration lock, applies migration 001, then checks its receipt before opening HTTP. Turn the flag off after success. Ordinary startup refuses an unmigrated schema. MySQL DDL auto-commits; a failed first migration resumes statement by statement with `CREATE TABLE IF NOT EXISTS`, and the version receipt is last. This is not an upgrade/repair system for manually altered schemas.
5. Keep `ACCEPTANCE_APPROVED=0` and enforcement/high-impact defaults unchanged. Verify HTTPS, Activity OAuth, Gateway connectivity, recovery, backups, storage and remaining acceptance gates before granting enforcement approval.

`npm start`, `npm run migrate`, and `npm run evaluate` use `--env-file-if-exists=.env` (Node >=22.13). The evaluator does not open a SQL database; it still needs an explicitly authorized evaluation key and corpus.

Preview and published processes using one database elect one controller. The loser serves HTTP/API, returns `standby` from `/api/health`, and retries every five seconds. `/api/ready` accepts a database-connected standby and reports `controller: standby`; for a leader, Gateway must be online. Only the elected process starts Gateway/worker and resets interrupted jobs/actions. Preview can win election: publishing does not guarantee the published process becomes leader. Gracefully stop the old leader when deliberately transferring ownership. Both instances need the same bot identity and encryption master key.

Leadership loss stops Gateway/worker and exits the affected process for host-supervised recovery. Requests already sent cannot be recalled. Graceful shutdown drains worker work before releasing the database lock, with a 30-second forced-exit limit. Never connect two different databases to the same bot: database-local election cannot coordinate them.

Private object storage is still filesystem-based. Verify a durable, shared `OBJECT_DIR` accessible to both preview/published processes, or operate only one instance. A shared SQL database alone does not share reference-image files. GoDaddy filesystem persistence/sharing, process lifetime, outbound Gateway WebSocket access and restart policy remain deployment acceptance checks.

## Adopting exact normalized-image matching

No schema migration or automatic backfill is required for the additive JSON fields in this change; PostgreSQL/MySQL migration 001 remains unchanged. Deploy only through the separately authorized acceptance process. Keep enforcement defaults and `ACCEPTANCE_APPROVED` unchanged. Matching fingerprints change, so old approvals must be refreshed through normal administrator calibration/approval. Legacy images remain functional through Jev fallback. To enable compatible hashes for a reference, explicitly re-upload its original source with the existing revision-checked API/Activity; a metadata-only edit is insufficient. Do not substitute its retained normalized JPEG and claim original-source equivalence. Hash-only rule tests do not supply model calibration positives; representative model-path samples remain necessary.
