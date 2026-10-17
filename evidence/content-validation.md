# Content analysis local validation

Scope: isolated branch feat/contextual-image-content, based on main after PR #18. No live TypeSafe or Discord calls and no production deployment.

- npm run check: passed.
- npm run build: passed.
- npm test: 254 tests passed, zero failures (Windows, October 17, 2026).
- node --test scripts/release-guard.test.mjs: 4 passed.
- npm audit --audit-level=high: zero vulnerabilities.
- node scripts/review-dependencies.mjs: 96 lockfile license declarations reviewed; no dependency additions.
- scripts/browser-smoke.py: desktop 1440x1000 and mobile 390x844 passed with no page errors; synthetic transport only. See content-browser-smoke.json and content editor/result screenshots.
- git diff --check: passed.

The existing PostgreSQL/MySQL integration runner now tests content JSON round trips, tenant isolation and canonical approval fingerprints; hosted CI results are recorded on the PR. Local checks above do not assert database/container or real-model acceptance.

The 26 generated labeled images are synthetic challenge fixtures. Model precision, recall, false positives/negatives and abstention rates have NOT been measured. The separate paid evaluator requires explicit authorization. Production deployment is not authorized by this validation record.

## Self-review follow-up

- High: the rule API accepted more than eight active content rules, causing whole-message evaluation to reject even otherwise valid reference matches. Creation and enabling now check the active-rule/question budgets within the guild transaction. Tests cover rejection, dormant rules, editing at capacity and freeing capacity.
- High: sample deduplication could hide a model false positive after a repeat test. Approval now rejects any qualifying false-positive trial before counting distinct samples. Regression tests cover both sample orders and both reference/content rules.
- Medium: the context preset excluded its own positive warning/report/education categories. Its exceptions now distinguish contextual framing from endorsement. Mocked eligibility tests cover the intended categories; this is not evidence of model quality.
- Medium: the content CLI applied future pricing rates before their effective dates. It now snapshots only effective rates and estimates from the attempt snapshot, matching the reference evaluator.

These are author self-review findings and fixes, not an independent GitHub approval. The follow-up build and whitespace checks passed. No UI changes were made in this follow-up.
