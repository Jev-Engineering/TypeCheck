# Acceptance matrix and remaining gates

Cost analytics update: accounting/HTTP/CLI tests, PostgreSQL/MySQL migration checks and synthetic desktop/mobile browser evidence are recorded in [VALIDATION.md](../VALIDATION.md). The feature reports estimated Jev input-token costs with coverage, not provider invoices; see [COSTS.md](COSTS.md). No real billing reconciliation, charged Jev call, live Discord action, hosted database connection, merge or deployment is part of this change. Live Activity/proxy validation, real-account rate provenance, operational accounting-failure/crash drills and independent review remain acceptance work. The existing Debian high-severity image blocker is unchanged and has not been rescanned or suppressed by this feature. `ACCEPTANCE_APPROVED` and enforcement/high-impact safeguards remain unchanged.

Current verdict: **NOT PRODUCTION READY**. Fresh local/container results are in ../VALIDATION.md; live provider, TLS and independent sign-off gates remain open.

MySQL port update (October 16, 2026): 155 local tests passed, the unchanged PostgreSQL harness passed, and MySQL 8.0.46 passed 104 assertions on a fresh loopback-only disposable database. Startup without `.env`, opt-in startup migration, a production-only install/build, and trusted/untrusted TLS behavior passed locally. Standby/loss/takeover tests use fake controllers and HTTP identities; real MySQL lock-loss testing terminates only a connection inside the disposable test container. See ../VALIDATION.md for commands and evidence.

The GoDaddy server version and private database guide remain unverified. No hosted migration/deployment, real Discord Activity/Gateway/moderation, shared/durable object storage, live provider accuracy, production fault/soak test, new runtime-image scan or independent security/operations sign-off is claimed. Enforcement and high-impact defaults remain disabled; `ACCEPTANCE_APPROVED=0` must stay in place. Earlier results below are historical.

The attached specification is preserved in USER_SPECIFICATION.md. “Implemented” means source code exists and is exercised locally where noted; it does not mean a live Discord/Jev deployment has passed acceptance.

| Specification area | Candidate implementation | Remaining acceptance |
|---|---|---|
| Image-only automatic monitoring | Gateway, worker, channel settings, ignore text, supported edits | Real intents, channel permissions, event/reconnect soak test |
| Jev image matching | Pinned official multipart/Noul adapter, four prompt modes | Real account compatibility and representative accuracy |
| Reference library and rule modes | Private uploads, groups, individual/library/any-image policies | Real provider matching and deployed storage |
| Moderation actions | Delete/warn/timeout/kick/ban/review/log-only, combinations | Real consenting test accounts, permission/hierarchy/rate tests |
| Activity UI | Six screens, rule/test dialogs, credential/RBAC controls | SDK bundle passed; real OAuth, proxy and Activity launch remain open |
| Administrator/moderator permissions | Live role-derived capabilities and restricted delegation | Real role revoke/change tests and independent review |
| Credential management | Encrypted, write-only, validated replacement and removal | Real TypeSafe key lifecycle and recovery test |
| Tenant isolation | Guild queries/constraints, encrypted AAD, object prefixes | Isolated PostgreSQL constraints/read isolation passed; live adversarial integration remains open |
| Logs, testing and calibration | Event/evaluation/audit/ledger, CSV, labeled trials, approvals | Real corpus results, long-running retention and unknown-outcome drill |
| Reliability | Fail-closed policy, durable claims, pauses, second check | Live network/crash recovery and load tests |
| Packaging | Source, migrations, Compose/Docker/CI and docs | Clean npm ci, image build and offline Compose restore passed; live hosted deployment remains open |

## Deliberate restrictions/differences

Native TypeScript UI/API replace the suggested React/framework stack. Filesystem object storage replaces a cloud bucket. PostgreSQL provides the queue instead of Redis. Pairwise Noul replaces optional Choice/Box batching; partial matching supplies no coordinates. Semantic mode cannot auto-punish. There is no repeat-offender escalation, mandatory two-person approval, or source-image history thumbnails. The warning text is derived from the configured rule reason rather than a separate full notification-template system. Bulk image modifications run sequentially and are not atomic.

These differences are visible design decisions, not silently claimed features. Optional future work does not obscure the main remaining mandatory gates: real provider performance, SDK/Activity auth, database integration and actual deployment.

## Manual acceptance sequence

1. Install/freeze dependencies; build the official SDK; pass local tests and the real PostgreSQL helper.
2. Launch Docker or a supported host, restore a test backup, verify private object storage/TLS and restart behavior.
3. Register/launch the Activity in a private server; verify admin, delegated, revoked and cross-guild identities.
4. Validate a real Jev key and failed replacement/rotation; confirm secrets never appear in responses/logs.
5. Build representative labeled/held-out matching datasets; evaluate exact, transformed, partial and hard negatives by pinned model.
6. Start in monitor-only; verify rule precedence, all image types in scope, multi-image and edit behavior, duplicate delivery, errors and exemptions.
7. With consenting test accounts, approve and enable each action, beginning with deletion/timeouts. Exercise role changes, pauses and ambiguous responses. Verify no duplicate user sanction.
8. Obtain independent security/operations sign-off and retain actual execution evidence before enabling kick/ban in a community.

Until those gates pass, completion of the original end-to-end acceptance checklist must not be claimed.

## Evidence rules for this run

Local: 147 passing tests; compiled official SDK; fresh audit and license inventory. Container: isolated PostgreSQL, offline identity startup, health/outage, project restart and separate-volume/database restore passed. Live Discord and Jev: no passing receipt yet. Do not count Claude browser setup progress, synthetic image fixtures, or mocked responses as live acceptance. Historical offline browser screenshots are unchanged.

Keep `ACCEPTANCE_APPROVED=0`. A production process refuses enforcement without this operator attestation, even if an old database contains enabled settings. Only an authorized operator may change it after reviewing completed acceptance evidence; rule approvals, thresholds, second verification and high-impact settings still apply. Development test actions require explicit test-guild/account authorization.

Runtime-image security is also OPEN: the final scan has 43 high package findings across 8 unique CVEs. The clean application npm audit does not close this gate. See DEPENDENCIES.md for retained results and vendor references.
