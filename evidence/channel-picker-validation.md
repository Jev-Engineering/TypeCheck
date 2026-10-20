# Category-grouped channel selection validation

The Agent setup planner and Settings use named, scrollable multiple-selection lists for monitored and excluded channels. Category headings and channel order come from Discord `parent_id` and `position`, with exact numeric ID ordering for position ties. The log destination is a single grouped channel selector; exempt roles use a named multiple-selection list.

## Local checks

- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: **388 tests passed**, with no failures or skipped tests. The HTTP tests used isolated loopback servers and synthetic adapters.
- Five new Node tests cover server ordering, large ID ties, missing parent/position metadata, Discord metadata preservation, and paginated onboarding inventory with category selection rejection.
- The compiled UI browser regression passed in Chromium **153.0.8010.0** at **1440 x 1000** and **390 x 844**. A focused dark-theme run also passed at both sizes; the native selected/excluded lists were visually compared with the requested control style.

The browser run used the real HTTP handlers, OAuth state/session flow, planner, and Settings persistence against isolated in-memory data. Discord, the model provider, and delayed WebMCP registration were synthetic. It verified 63 eligible channels across multiple categories, including entries beyond the paginated agent inventory's first 50; exact submitted selection IDs; category/channel/role name escaping; preserved drafts after tool registration, refresh, failed requests, preview, and navigation; Settings save/reload; empty and failed inventory recovery; and no horizontal viewport overflow or page errors. No external Discord/provider requests ran.

The full browser report is [channel-picker-browser.json](channel-picker-browser.json), and the focused dark-theme report is [channel-picker-dark-browser.json](channel-picker-dark-browser.json). Reproduce after building:

```sh
node scripts/channel-picker-browser.mjs
node scripts/channel-picker-browser.mjs --render-dark
```

Playwright must be available to the validation environment; it is not a production dependency. `CHROMIUM_EXECUTABLE` optionally selects an installed Chromium binary, and `CHANNEL_PICKER_EVIDENCE_DIR` selects an output directory. This local browser harness is separate from GitHub CI, which runs the Node test suite and its existing database/container checks.

## Review

Independent source review covered grouping and selectable types, draft retention, safe rendering, authenticated metadata access, and release-scoped static module imports. The existing concatenated browser smoke script was updated to include the new selector dependencies, and the standalone onboarding smoke script now uses native listbox/combobox controls.

These are implementation and isolated integration results. They do not certify a live Discord guild, native browser-agent discovery, or production deployment.


Generated browser captures are omitted from this portable source checkpoint. Run the documented browser harness to recreate them. The implementation, tests, and recorded results are preserved.
