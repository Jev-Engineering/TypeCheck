# Content analysis local validation

Scope: isolated branch feat/contextual-image-content, based on main after PR #18. No live TypeSafe or Discord calls and no production deployment.

- npm run check: passed.
- npm run build: passed.
- npm test: 251 tests passed, zero failures (Windows, October 17, 2026).
- node --test scripts/release-guard.test.mjs: 4 passed.
- npm audit --audit-level=high: zero vulnerabilities.
- node scripts/review-dependencies.mjs: 96 lockfile license declarations reviewed; no dependency additions.
- scripts/browser-smoke.py: desktop 1440x1000 and mobile 390x844 passed with no page errors; synthetic transport only. See content-browser-smoke.json and content editor/result screenshots.
- git diff --check: passed.

The existing PostgreSQL/MySQL integration runner now tests content JSON round trips, tenant isolation and canonical approval fingerprints; hosted CI results are recorded on the PR. Local checks above do not assert database/container or real-model acceptance.

The 26 generated labeled images are synthetic challenge fixtures. Model precision, recall, false positives/negatives and abstention rates have NOT been measured. The separate paid evaluator requires explicit authorization. Production deployment is not authorized by this validation record.
