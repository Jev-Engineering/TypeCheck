# Workflow screenshot provenance

Captured from the implemented Activity with `scripts/pack-ui-server.mjs` and `scripts/pack-browser-workflow.js` through the already-installed Docker Playwright MCP image. Desktop viewport: 1440×1050; mobile: 390×844. Screenshots are full-page captures, not generated mockups.

The banner explicitly says **OFFLINE INTEGRATION TEST**. OAuth/SDK, guild membership and model transport are synthetic; HTTP handlers, pack validation, preview, writes and UI are real. State lives in an isolated temporary memory store and is removed when the harness stops. See `evidence/packs-browser.json` for actions and outcomes. No live Discord, model accuracy or deployment evidence is implied.

`starters-desktop.png`: starter selection. `import-preview-desktop.png`: validated image-analysis import. `import-preview-mobile.png`: complete uploaded pack preview and mapping controls. `fresh-guild-result.png`: reference starter adoption without duplicates after first-login seeding.

The sample reference used in the configured guild is the synthetic test fixture from `tests/helpers.ts`. Supplied scam-image originals are preserved separately in `data/scams`; screenshot generation does not modify or establish redistribution rights for them.
