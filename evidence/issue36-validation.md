# Issue 36 validation — 2026-10-17

Branch: `feat/historical-scans`, rebased onto `3677d0e` before PR publication.
Issue and open PRs were inspected before implementation; no open overlapping PR
was present. Existing untracked `docs/assets/discord/` artwork was preserved.

Results:

- `npm test`: 292 passed, 0 failed, 0 skipped.
- `npm run build` and `npm run check`: passed.
- Historical focused suite after final limiter/active-scan-cap refinements:
  19 passed, 0 failed.
- `scripts/test-historical-persistence.mjs`: passed against disposable local
  PostgreSQL 16 and MySQL 8.4 databases. Covers restart/checkpoints, exact hash,
  review-only evidence, lifecycle, guild isolation, permission/policy loss,
  partial-failure accounting, concurrent cooldown admission and live deferral.
- Existing `scripts/test-postgres.mjs`: passed.
- Existing `scripts/test-mysql.mjs`: passed, 104 assertions.
- Offline compiled-UI browser smoke: 30 checks passed across desktop and mobile,
  no page errors or horizontal overflow. Includes historical scope/budget preview
  and explicit review-only confirmation. See `issue36-browser-smoke.json` and
  `issue36-historical-{desktop,mobile}.png`.
- Release guard/source/migration-receipt/hosting-handoff suites: 13 passed,
  3 skipped by the existing Windows-specific shell-test conditions.
- `git diff --check`: passed.

The synthetic history test lazily generates 2,000 messages and asserts one
bounded pending message, scan-state size below 5 KB for that fixture, and no
historical queue growth. It does not represent a real Discord throughput benchmark.

Testing found and fixed a MySQL nested-lock conflict, a cancellation/checkpoint
race, and a clipped mobile budget preview. The browser harness also needed the
existing connection helper included in its synthetic module bundle.

Official Discord and TypeSafe references, unverified numeric provider entitlements,
scope exclusions and operational limits are recorded in
[`docs/HISTORICAL_SCANS.md`](../docs/HISTORICAL_SCANS.md).

No production deployment, production scan, or real Discord/Jev acceptance run
was performed. Those require a separately authorized test guild/provider budget.
Migration `003` is required before running this build against an existing database.
