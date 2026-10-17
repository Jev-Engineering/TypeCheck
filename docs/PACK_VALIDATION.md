# Moderation pack validation

Scope: [issue #41](https://github.com/Jev-Engineering/TypeCheck/issues/41). These are local software and isolated persistence/browser results, not model accuracy or live-deployment acceptance. No production deployment or paid evaluation was performed.

## Commands and observations (2026-10-17)

| Command | Result / evidence |
|---|---|
| `npm ci --no-audit --no-fund` | Clean install, 44 packages; npm reported esbuild install-script policy notice, build subsequently succeeded. |
| `npm run check` | TypeScript passed. |
| `npm run build` | TypeScript and official Discord SDK bundling passed; [transcript](../evidence/packs-build.txt). |
| `npm test` | 348 tests passed, zero failed/skipped; [transcript](../evidence/packs-local-tests.txt). |
| `node --test dist/tests/packs.test.js` | 27 pack-specific tests passed; [transcript](../evidence/packs-focused-tests.txt). |
| `npm audit --audit-level=high` | Zero vulnerabilities; [transcript](../evidence/packs-audit.txt). |
| `node scripts/review-dependencies.mjs` | Existing dependency declarations/licenses passed; no new package; [transcript](../evidence/packs-dependencies.txt). |
| `node --test scripts/release-guard.test.mjs scripts/release-source.test.mjs scripts/migration-receipt.test.mjs scripts/hosting-handoff.test.mjs` | 13 passed, 3 platform-dependent skips on Windows; [transcript](../evidence/packs-release-tests.txt). Linux CI runs the platform-specific checks. |
| `node scripts/test-pack-databases.mjs` | Disposable loopback-only PostgreSQL 16 and MySQL 8.0.46: pack persistence tests plus existing backend suites passed; [transcript](../evidence/packs-databases.txt). Only containers created by this runner were removed. MySQL connection-refused lines during first initialization precede successful readiness and tests. |
| `npm run test:compose` | Local intermediate candidate build and offline recovery/restore passed; [transcript](../evidence/packs-compose.txt), [machine result](../evidence/container-result.json). Final-head Compose/runtime scan is also required in CI. |
| `node scripts/build-starter-packs.mjs` | All four self-contained sample packs generated and parsed through the real validator. Source image checksums validated. |
| `node scripts/pack-ui-server.mjs` then `python scripts/pack-browser.py scripts/pack-browser-workflow.js` | Ephemeral Docker Playwright MCP against real Activity and real HTTP handlers; temporary memory persistence, fake guild/Discord/model transports. [Browser transcript](../evidence/packs-browser.json), [workflow images](MODERATION_PACKS.md#workflow-images). No mockup stands in for the implementation. |

## Coverage

Pack tests cover standalone reference/definition and complete policy round trips (including a single grouped image without its siblings), group/individual dependency closure and reconstruction, native text-definition preservation, exact normalized asset bytes, secret/history/path exclusion, role/channel mapping and permission loss, live administrator/guild boundaries, keep/replace conflicts, repeat import and explicit upgrades, local edits and unrelated records, deletion tombstones and first-login starter adoption, disabled/unapproved imported rules, different-modality replacement, source-evidence binding/staleness, corrupt/unsupported/malicious inputs, invalid checksums/paths/counts/pixels, expanded bytes, upload/container/structural work bounds, injected filesystem/database failures and orphan collection, and snapshot/decision/input changes, inherited-property conflict choices, and complete exports at the supported 850-component/750-mapping capacity.

Both backend drills migrate twice, import the 37-component combined pack, read it back through a second connection, export complete policy and map settings, preserve local edits, reject stale previews, roll back an injected final-audit failure, isolate guild reads, and admit only one of two concurrent imports. Existing PostgreSQL durability/idempotency/election/recovery and MySQL 104-assertion suites run alongside these tests. CI adds this pack drill to both existing database lanes; checks and approval gates are not weakened.

Browser checks exercise configured-guild starter selection, preview/apply, repeat import, complete download/upload, desktop (1440px) and mobile (390px) layouts, mapped complete-policy application, individual-image export, and fresh-guild adoption of the 33 seeded references. Screenshots contain the offline integration label. The harness replaces only SDK/transport and the offline banner; policy requests use the production HTTP handlers and domain parsers.

## Discovered failures fixed before publication

Tests found and resolved receipt-revision aliasing during repeat import; deleted dependencies being restored or producing incomplete rules; retained content fields after a rule-type replacement; encoding damage introduced during editing; mobile digest overflow; a starter-loading timing gap; and regex stack exhaustion on large base64 values. The base64 boundary now uses bounded decoding plus canonical re-encoding. MySQL test readiness uses TCP rather than the temporary initialization socket. Backend cleanup removes only its test guild's dependent rows before guild deletion.

## Remaining evidence boundaries

No paid or live model evaluation was run. No false-positive/negative rates, abstention rates, accuracy, representative coverage or held-out results are asserted. The 33 supplied references are owner-reviewed positive examples only, not a balanced or held-out dataset; redistribution rights remain unestablished. Image-analysis/combined/custom policies are editable templates, not verified classifiers. Imported evidence is an untrusted historical declaration and never destination approval.

No production deployment/migration, live Discord OAuth/proxy/role-revocation or moderation action, production storage/backup drill, or independent security/operations approval is claimed. These remain deployment acceptance work. Older installations missing both seed receipts and the retained seed audit event cannot distinguish deleted legacy starter references from never-installed examples. Young unreferenced filesystem objects are intentionally retained for safe collection after 24 hours.

GitHub CI, review and merge receipts belong to the linked PR. A passing software build does not change any starter into a model-evaluated or live-validated pack.
