// Compiled UI + real isolated HTTP/MemoryStore, with synthetic Discord/provider adapters.
// Run `npm run build`, then `node scripts/channel-picker-browser.mjs`.
// Add `--render-dark` for focused dark-theme list screenshots only.
// Playwright may be installed externally; no production browser dependency is required.
// Optional: CHROMIUM_EXECUTABLE, CHANNEL_PICKER_EVIDENCE_DIR, CODEX_PRIMARY_RUNTIME_NODE_MODULES.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, G, ROLE } from '../dist/tests/helpers.js';
import { AppError } from '../dist/shared/domain.js';
import { createHttp } from '../dist/server/http.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const paths = [root, process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean);
const { chromium } = require(require.resolve('playwright', { paths }));
const evidence = resolve(process.env.CHANNEL_PICKER_EVIDENCE_DIR ?? join(root, 'evidence'));
const darkOnly = process.argv.includes('--render-dark');
const snowflake = n => String(100000000000000000n + BigInt(n));
const ids = {
    uncategorized: snowflake(21), orphan: snowflake(22), weird: snowflake(23),
    announcement: snowflake(24), excluded: snowflake(25), voice: snowflake(26),
    forum: snowflake(27), thread: snowflake(28),
    alpha: snowflake(101), beta: snowflake(102), missing: snowflake(103),
    weirdRole: snowflake(32),
};
const names = {
    alpha: 'Welcome <&> "lobby"', beta: 'Support & operations',
    weird: '<img src=x onerror=alert(1)> & "quoted"',
    weirdRole: 'Helpers <script>alert(1)</script> & friends',
};
const extraChannels = Array.from({ length: 58 }, (_, i) => ({
    id: snowflake(200 + i), name: `support-${String(i + 1).padStart(2, '0')}`,
    type: 0, parent_id: ids.beta, position: 20 + i, guild_id: G,
}));
const farChannel = extraChannels.at(-1).id;
const inventory = {
    name: 'OFFLINE SYNTHETIC SERVER — channel-selection regression',
    roles: [
        { id: G, name: '@everyone', position: 0, permissions: '0' },
        { id: ROLE, name: 'Image moderator', position: 1, permissions: '0' },
        { id: ids.weirdRole, name: names.weirdRole, position: 2, permissions: '0' },
    ],
    // Deliberately scramble transport order. Server positions, not alphabetic/input order,
    // determine category and channel order. Include unsupported kinds and an orphan.
    channels: [
        ...extraChannels.toReversed(),
        { id: ids.beta, name: names.beta, type: 4, position: 8, guild_id: G },
        { id: ids.excluded, name: 'private-discussion', type: 0, parent_id: ids.beta, position: 1, guild_id: G },
        { id: ids.announcement, name: 'announcements', type: 5, parent_id: ids.alpha, position: 3, guild_id: G },
        { id: ids.voice, name: 'voice-only', type: 2, parent_id: ids.alpha, position: 0, guild_id: G },
        { id: ids.weird, name: names.weird, type: 0, parent_id: ids.alpha, position: 1, guild_id: G },
        { id: ids.alpha, name: names.alpha, type: 4, position: 2, guild_id: G },
        { id: ids.orphan, name: 'orphaned-text', type: 0, parent_id: ids.missing, position: 7, guild_id: G },
        { id: ids.uncategorized, name: 'general', type: 0, parent_id: null, position: 0, guild_id: G },
        { id: ids.forum, name: 'forum-only', type: 15, parent_id: ids.alpha, position: 4, guild_id: G },
        { id: ids.thread, name: 'thread-only', type: 11, parent_id: ids.uncategorized, position: 5, guild_id: G },
    ],
};
const expectedOrder = [ids.uncategorized, ids.orphan, ids.weird, ids.announcement, ids.excluded, ...extraChannels.map(c => c.id)];
const cleanup = [];
const f = await fixture({ after: fn => cleanup.push(fn) });
let inventoryMode = 'full', metadataGate = null, failNextPlan = false;
f.discord.metadata = async () => {
    if (metadataGate) await metadataGate;
    if (inventoryMode === 'error') throw new AppError('synthetic_metadata_unavailable', 502);
    return structuredClone(inventoryMode === 'empty' ? { ...inventory, channels: [], roles: [] } : inventory);
};

// Reserve an unused loopback port before constructing the immutable allowed-origin set.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const config = {
    port, production: false, publicOrigin: origin, clientId: G,
    clientSecret: 'synthetic-only', botToken: 'synthetic-only', databaseUrl: 'unused',
    masterKey: 'unused', objectDir: 'unused', model: 'jev-1.14.0', apiOnly: true,
};
const server = createHttp(f.services, config);
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (request, response) => {
    if (failNextPlan && request.method === 'POST' && request.url === `/api/g/${G}/onboarding/plans`) {
        failNextPlan = false;
        request.resume();
        response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'synthetic_plan_failure' }));
        return;
    }
    handler(request, response);
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');

const reports = [], errors = [], externalRequests = [];
let browser;
async function contextFor(viewport, delayedTools = false) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: darkOnly ? 'dark' : 'light' });
    // Only the OAuth authorize redirect is simulated. State, cookies, code exchange,
    // authentication and every application request use the real isolated HTTP service.
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin === 'https://discord.com' && url.pathname === '/oauth2/authorize') {
            return route.fulfill({ status: 302, headers: {
                Location: `${origin}/api/auth/browser/callback?code=admin-code&state=${encodeURIComponent(url.searchParams.get('state'))}`,
            } });
        }
        externalRequests.push(url.origin + url.pathname);
        return route.abort();
    });
    if (delayedTools) {
        await context.addInitScript(() => {
            const tools = new Map();
            let release;
            const ready = new Promise(resolve => { release = resolve; });
            window.__channelPickerTools = tools;
            window.__releaseChannelPickerTools = release;
            Object.defineProperty(document, 'modelContext', { value: {
                async registerTool(tool, { signal }) {
                    await ready;
                    tools.set(tool.name, tool);
                    signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
                },
            } });
        });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(String(error)));
    return { context, page };
}
async function login(page) {
    await page.goto(origin + '/setup');
    await page.getByLabel('Discord server ID', { exact: true }).fill(G);
    await page.getByRole('button', { name: 'Sign in with Discord', exact: true }).click();
    await page.getByRole('heading', { name: 'Agent setup', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh channels and roles', exact: true }).waitFor();
}
const selected = control => control.evaluate(node => [...node.selectedOptions].map(option => option.value));
const controls = page => ({
    channels: page.getByRole('listbox', { name: 'Selected channels (multiple selection)', exact: true }),
    excluded: page.getByRole('listbox', { name: 'Excluded channels', exact: true }),
    exempt: page.getByRole('listbox', { name: 'Exempt roles', exact: true }),
    log: page.getByRole('combobox', { name: 'Log channel', exact: true }),
    custom: page.getByLabel(/^Optional customization JSON/),
});
async function assertDraft(page, draft) {
    const c = controls(page);
    assert.deepEqual(await selected(c.channels), draft.channels, 'selected channel draft must survive rendering');
    assert.deepEqual(await selected(c.excluded), draft.excludedChannels, 'excluded channel draft must survive rendering');
    assert.deepEqual(await selected(c.exempt), draft.exemptRoles, 'exempt role draft must survive rendering');
    assert.equal(await c.log.inputValue(), draft.logChannel);
    assert.deepEqual(JSON.parse(await c.custom.inputValue()), draft.customizations);
    assert.equal(await page.getByLabel('Scam and phishing review', { exact: false }).isChecked(), true);
}
async function assertNoOverflow(page, label) {
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(sizes.document <= sizes.viewport + 1, `${label}: document overflows ${JSON.stringify(sizes)}`);
    for (const select of await page.locator('select').all()) {
        const box = await select.boundingBox();
        assert.ok(!box || box.x >= -1 && box.x + box.width <= sizes.viewport + 1, `${label}: select extends outside viewport`);
    }
}
async function assertInventory(page) {
    const c = controls(page);
    await page.waitForFunction(() => [...document.querySelectorAll('select[multiple]')].some(s => s.options.length > 50));
    for (const control of [c.channels, c.excluded]) {
        assert.equal(await control.evaluate(node => node.multiple), true);
        assert.equal(await control.getAttribute('size'), '8');
        assert.deepEqual(await control.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)), ['Uncategorized', names.alpha, names.beta]);
        assert.deepEqual(await control.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), expectedOrder);
        assert.equal(await control.locator(`option[value="${ids.weird}"]`).textContent(), names.weird);
        assert.equal(await control.locator('img,script').count(), 0, 'Discord names must be rendered as text');
    }
    assert.equal(await c.exempt.evaluate(node => node.multiple), true);
    assert.equal(await c.exempt.locator(`option[value="${ids.weirdRole}"]`).textContent(), names.weirdRole);
    assert.equal(await c.log.getAttribute('multiple'), null);
    assert.equal(await c.log.locator('option').first().textContent(), 'Keep current log destination');
    assert.deepEqual(await c.log.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)), ['Uncategorized', names.alpha, names.beta]);
    assert.equal(await page.getByLabel(/channel IDs|role IDs|Log channel ID/i).count(), 0, 'manual ID controls must be removed');
    assert.equal(await page.locator('textarea').count(), 1, 'the only remaining textarea is optional customization JSON');
}
async function preview(page, expected) {
    const responsePromise = page.waitForResponse(response => response.url() === `${origin}/api/g/${G}/onboarding/plans` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Preview configuration', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    assert.deepEqual(response.request().postDataJSON(), expected, 'named controls must submit exact selected IDs');
    await page.getByRole('heading', { name: 'Proposed configuration', exact: true }).waitFor();
    await assertDraft(page, expected);
}
async function seedSettings() {
    const old = await f.store.getSettings(G);
    await f.store.putSettings(G, { ...old.value,
        channels: [ids.uncategorized], excludedChannels: [ids.excluded], exemptRoles: [ROLE], logChannel: ids.uncategorized,
    }, old.revision);
}

try {
    await mkdir(evidence, { recursive: true });
    browser = await chromium.launch({ headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    if (!darkOnly) {
        for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
            inventoryMode = 'full';
            await seedSettings();
            const { context, page } = await contextFor({ width, height }, true);
            await login(page);
            await assertInventory(page);
            const draft = {
                presets: ['scam_phishing'], channels: [ids.uncategorized, ids.weird, farChannel],
                excludedChannels: [ids.excluded], exemptRoles: [ids.weirdRole], logChannel: ids.announcement,
                customizations: { text_scams: { name: 'Synthetic browser regression scam review' } },
            };
            const c = controls(page);
            await page.getByLabel('Scam and phishing review', { exact: false }).check();
            await c.channels.selectOption(draft.channels);
            await c.excluded.selectOption(draft.excludedChannels);
            await c.exempt.selectOption(draft.exemptRoles);
            await c.log.selectOption(draft.logChannel);
            await c.custom.fill(JSON.stringify(draft.customizations));
            await assertDraft(page, draft);

            // This registry is an explicit asynchronous contract double, not a claim of
            // native browser-agent support. Its delayed completion previously reset drafts.
            await page.evaluate(() => window.__releaseChannelPickerTools());
            await page.waitForFunction(() => window.__channelPickerTools?.size === 8);
            await page.getByText('Browser tools registered.', { exact: false }).waitFor();
            await assertDraft(page, draft);
            await page.getByRole('button', { name: 'Refresh', exact: true }).click();
            await assertDraft(page, draft);

            let releaseMetadata;
            metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
            await page.getByRole('button', { name: 'Refresh channels and roles', exact: true }).click();
            await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Preview configuration' && b.disabled));
            metadataGate = null;
            releaseMetadata();
            await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Preview configuration' && !b.disabled));
            await assertDraft(page, draft);

            failNextPlan = true;
            const failure = page.waitForResponse(response => response.url().endsWith('/onboarding/plans') && response.status() === 503);
            await page.getByRole('button', { name: 'Preview configuration', exact: true }).click();
            await failure;
            await page.locator('.notice.error').filter({ hasText: /synthetic.*plan.*failure/i }).waitFor();
            await assertDraft(page, draft);
            await preview(page, draft);
            await assertNoOverflow(page, `${label} Agent setup and preview`);
            await page.screenshot({ path: join(evidence, `channel-picker-planner-${label}.png`), fullPage: true });

            await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
            const monitored = page.getByRole('listbox', { name: 'Monitored channels (multiple selection)', exact: true });
            const excluded = page.getByRole('listbox', { name: 'Excluded channels', exact: true });
            const log = page.getByRole('combobox', { name: 'Moderator log channel', exact: true });
            const exempt = page.getByRole('listbox', { name: 'Exempt Discord roles', exact: true });
            await monitored.waitFor();
            assert.deepEqual(await selected(monitored), [ids.uncategorized], 'Settings loads saved channel IDs as selected names');
            assert.deepEqual(await selected(excluded), [ids.excluded]);
            assert.equal(await log.inputValue(), ids.uncategorized);
            assert.deepEqual(await selected(exempt), [ROLE]);
            assert.deepEqual(await monitored.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)), ['Uncategorized', names.alpha, names.beta]);
            await monitored.selectOption([ids.weird, farChannel]);
            await excluded.selectOption([ids.uncategorized]);
            await log.selectOption(ids.announcement);
            await exempt.selectOption([ids.weirdRole]);
            const saved = page.waitForResponse(response => response.url().endsWith('/settings') && response.request().method() === 'PUT');
            await page.getByRole('button', { name: 'Save settings', exact: true }).click();
            const savedResponse = await saved;
            assert.equal(savedResponse.status(), 200, await savedResponse.text());
            assert.deepEqual(savedResponse.request().postDataJSON().value.channels, [ids.weird, farChannel]);
            assert.deepEqual(savedResponse.request().postDataJSON().value.excludedChannels, [ids.uncategorized]);
            assert.deepEqual(savedResponse.request().postDataJSON().value.exemptRoles, [ids.weirdRole]);
            await page.getByText('Settings saved. Review any stale rule approvals.', { exact: true }).waitFor();
            assert.deepEqual(await selected(monitored), [ids.weird, farChannel]);
            assert.deepEqual(await selected(excluded), [ids.uncategorized]);
            assert.equal(await log.inputValue(), ids.announcement);
            assert.deepEqual(await selected(exempt), [ids.weirdRole]);
            await page.getByRole('button', { name: 'Refresh', exact: true }).click();
            await monitored.waitFor();
            assert.deepEqual(await selected(monitored), [ids.weird, farChannel], 'saved selections survive a server reload');
            assert.deepEqual(await selected(excluded), [ids.uncategorized]);
            await assertNoOverflow(page, `${label} Settings`);
            await page.screenshot({ path: join(evidence, `channel-picker-settings-${label}.png`), fullPage: true });
            await page.getByRole('navigation').getByRole('button', { name: 'Agent setup', exact: true }).click();
            await assertDraft(page, draft);
            reports.push({ viewport: label, eligibleChannels: expectedOrder.length,
                verified: ['server category/channel ordering', 'uncategorized/orphaned channels', 'text and announcement types only',
                    'native multiple selection', 'escaped category/channel/role names', 'complete inventory beyond 50 channels',
                    'exact preview payload', 'draft retained across async tool registration, metadata refresh, HTTP failure, preview and navigation',
                    'saved Settings round trip', 'no horizontal viewport overflow'],
            });
            await context.close();
        }

        inventoryMode = 'empty';
        const { context, page } = await contextFor({ width: 390, height: 844 });
        await login(page);
        await page.getByText('No text or announcement channels are available.', { exact: true }).first().waitFor();
        assert.equal(await controls(page).channels.locator('option:enabled').count(), 0);
        assert.equal(await controls(page).excluded.locator('option:enabled').count(), 0);
        assert.equal(await controls(page).channels.isDisabled(), true);
        await assertNoOverflow(page, 'empty inventory');
        inventoryMode = 'error';
        await page.getByRole('button', { name: 'Refresh channels and roles', exact: true }).click();
        await page.locator('.notice.error').filter({ hasText: /channel/i }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Preview configuration', exact: true }).isDisabled(), true);
        inventoryMode = 'full';
        await page.getByRole('button', { name: 'Refresh channels and roles', exact: true }).click();
        await assertInventory(page);
        assert.equal(await page.getByRole('button', { name: 'Preview configuration', exact: true }).isEnabled(), true);
        await controls(page).channels.selectOption([farChannel]);
        inventoryMode = 'error';
        await page.getByRole('button', { name: 'Refresh channels and roles', exact: true }).click();
        await page.locator('.notice.error').filter({ hasText: /channel/i }).waitFor();
        inventoryMode = 'full';
        await page.getByRole('button', { name: 'Refresh channels and roles', exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Preview configuration' && !b.disabled));
        assert.deepEqual(await selected(controls(page).channels), [farChannel], 'inventory retry must preserve draft IDs');
        reports.push({ inventory: 'empty and HTTP error states; disabled preview after failure; complete retry recovery; selected draft survives failure' });
        await context.close();
    } else {
        for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
            const { context, page } = await contextFor({ width, height });
            await login(page);
            await assertInventory(page);
            const c = controls(page);
            await c.channels.selectOption([ids.uncategorized, ids.announcement]);
            await c.excluded.selectOption([ids.excluded]);
            await assertNoOverflow(page, `${label} dark-theme lists`);
            assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
            // Crop the browser capture to the two actual list controls, retaining their
            // original page styles and native option rendering without image edits.
            const clip = await c.channels.evaluate(node => {
                const first = node.closest('label').getBoundingClientRect();
                const second = [...document.querySelectorAll('select[multiple]')][1].closest('label').getBoundingClientRect();
                return { x: first.x + scrollX, y: first.y + scrollY, width: Math.max(first.width, second.width), height: second.bottom - first.y };
            });
            await page.screenshot({ path: join(evidence, `channel-picker-dark-${label}.png`), fullPage: true, clip });
            reports.push({ viewport: label, width, height, colorScheme: 'dark', eligibleChannels: expectedOrder.length,
                verified: ['native list rendering', 'category grouping and complete inventory', 'selected and excluded states', 'no horizontal viewport overflow'],
                screenshot: `channel-picker-dark-${label}.png`,
            });
            await context.close();
        }
    }
    assert.deepEqual(errors, [], 'browser page errors');
    assert.deepEqual(externalRequests, [], 'no live Discord/provider or other third-party requests');
    const report = {
        scope: 'Offline compiled UI, real isolated HTTP and in-memory transactions. Synthetic Discord/provider and asynchronous WebMCP registry. No live Discord or provider acceptance claimed.',
        browser: browser.version(), results: reports, pageErrors: errors, externalRequests, passed: true,
    };
    await writeFile(join(evidence, darkOnly ? 'channel-picker-dark-browser.json' : 'channel-picker-browser.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
} finally {
    metadataGate = null;
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const fn of cleanup) await fn();
}
