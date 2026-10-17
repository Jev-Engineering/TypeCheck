/** Consent HTTP + real SQL regression. Only generated guilds in an explicitly opted-in loopback test DB.
 * No .env, Discord requests, provider calls or worker/controller startup.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase, migrateDatabase } from '../dist/server/database.js';
import { createHttp } from '../dist/server/http.js';
import { Services } from '../dist/server/services.js';
import { digest, Vault } from '../dist/server/security.js';
import { DATA_USE_NOTICE_VERSION, DATA_USE_CONSENT_KEYS } from '../dist/shared/domain.js';
import { Packs, exportPack, validatePack } from '../dist/server/packs.js';
import { Onboarding } from '../dist/server/onboarding.js';
import { installTextStarters } from '../dist/server/text-starters.js';

assert.equal(process.env.ALLOW_DATABASE_TESTS, 'true');
assert.ok(process.env.TEST_DATABASE_URL, 'Use TEST_DATABASE_URL, never production DATABASE_URL');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Disposable loopback DB required');
const db = await openDatabase(url.href);
let reader = await openDatabase(url.href);
const { pool, store, kind } = db;
const guild = String(Date.now()) + '4901', foreign = String(Date.now()) + '4902', actor = guild + '1';
const session = randomBytes(32).toString('hex'), origin = 'http://localhost:4199';
let administrator = true, failure = '';
// Fail AFTER the SQL write to prove transaction rollback of both rows, not just early validation.
const wrapped = new Proxy(store, { get(target, key) {
    if (key === 'withGuild') return (g, work) => target.withGuild(g, tx => work(new Proxy(tx, { get(t, k) {
        if (k === 'putSettings') return async (...args) => { await t.putSettings(...args); if (failure === 'settings') throw Error('injected_settings_failure'); };
        if (k === 'put') return async (...args) => { await t.put(...args); if (failure === 'audit' && args[0] === 'audit' && args[1].event === 'data_use.consent_updated') throw Error('injected_audit_failure'); };
        const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
    } })));
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
} });
const discord = {
    memberInfo: async (g, user) => ({ guildId: g, userId: user, owner: false, administrator, roles: [] }),
    metadata: async () => ({ channels: [], roles: [] })
};
const services = new Services(wrapped, null, new Vault(randomBytes(32).toString('base64')), null, discord);
const server = createHttp(services, { port: 0, production: false, publicOrigin: origin, clientId: actor, clientSecret: 'synthetic', botToken: 'synthetic', databaseUrl: 'unused', masterKey: 'unused', objectDir: 'unused', model: 'jev-1.14.0', apiOnly: true });
const mark = kind === 'mysql' ? '?' : '$1';
const receipts = async () => (await reader.store.all('audit', guild)).filter(a => a.event === 'data_use.consent_updated');
let count = 0;
try {
    await migrateDatabase(pool, kind);
    await store.getSettings(guild); await store.getSettings(foreign);
    // Simulate old persisted JSON, not just an in-memory parser call.
    const legacy = (await store.getSettings(guild)).value;
    for (const key of DATA_USE_CONSENT_KEYS) delete legacy[key];
    await pool.query(`UPDATE guilds SET settings=${kind === 'mysql' ? '?' : '$2'} WHERE id=${kind === 'mysql' ? '?' : '$1'}`, kind === 'mysql' ? [JSON.stringify(legacy), guild] : [guild, legacy]);
    const initial = await reader.store.getSettings(guild);
    for (const key of DATA_USE_CONSENT_KEYS) assert.equal(initial.value[key], false);
    await store.createSession(digest(session), { userId: actor, guildId: guild, expiresAt: Date.now() + 600_000 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (value, revision, noticeVersion = DATA_USE_NOTICE_VERSION, path = guild) => {
        const r = await fetch(`${base}/api/g/${path}/settings`, { method: value === undefined ? 'GET' : 'PUT', headers: { Origin: origin, Authorization: 'Bearer ' + session, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify({ value, revision, noticeVersion }) }) });
        return { status: r.status, data: await r.json() };
    };
    const save = async value => request(value, (await reader.store.getSettings(guild)).revision);
    for (const key of DATA_USE_CONSENT_KEYS) for (const invalid of [null, 'true', 'false', 0, 1, [], {}]) assert.equal((await save({ [key]: invalid })).status, 400);
    assert.equal((await request({ typesafeReviewConsent: true }, initial.revision, 'stale-notice')).status, 409);
    for (const value of [{ typesafeReviewConsent: true }, { completeTechTrainingConsent: true }, { typesafeReviewConsent: false }, { completeTechTrainingConsent: false }]) {
        const previous = (await reader.store.getSettings(guild)).value;
        assert.equal((await save(value)).status, 200);
        const after = (await request(undefined)).data.value;
        for (const key of DATA_USE_CONSENT_KEYS) assert.equal(after[key], value[key] ?? previous[key]);
        const audit = await receipts(); assert.equal(audit.length, ++count);
        const receipt = audit.find(a => DATA_USE_CONSENT_KEYS.every(k => a.detail.previous[k] === previous[k] && a.detail.current[k] === after[k]));
        assert.ok(receipt); assert.equal(receipt.actor, actor); assert.equal(receipt.guildId, guild);
        assert.ok(Number.isFinite(Date.parse(receipt.createdAt))); assert.equal(receipt.detail.noticeVersion, DATA_USE_NOTICE_VERSION);
        assert.equal(after.logRetentionDays, initial.value.logRetentionDays); assert.equal(after.enforcement, initial.value.enforcement);
    }
    assert.equal((await save({})).status, 200); assert.equal((await receipts()).length, count);
    for (failure of ['settings', 'audit']) {
        const before = await reader.store.getSettings(guild);
        assert.equal((await save({ typesafeReviewConsent: true })).status, 500);
        assert.deepEqual(await reader.store.getSettings(guild), before);
        assert.equal((await receipts()).length, count);
    }
    failure = '';
    const beforeRace = await reader.store.getSettings(guild);
    const race = await Promise.all(DATA_USE_CONSENT_KEYS.map(key => request({ [key]: true }, beforeRace.revision)));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]); assert.equal((await receipts()).length, ++count);
    const beforeSetup = (await reader.store.getSettings(guild)).value;
    await installTextStarters(services, guild, actor);
    const packs = new Packs(services), pack = await exportPack(services, guild, { complete: true });
    for (const key of DATA_USE_CONSENT_KEYS) {
        assert.equal(Object.hasOwn(pack.policy.settings, key), false);
        for (const value of [true, false]) {
            const malicious = structuredClone(pack); malicious.policy.settings[key] = value;
            await assert.rejects(validatePack(malicious), /consent_not_portable/);
        }
    }
    const preview = await packs.preview(guild, actor, pack, { policy: true });
    await packs.apply(guild, actor, pack, { policy: true }, preview.token);
    const onboarding = new Onboarding(services), binding = 'synthetic-session';
    const plan = await onboarding.plan(guild, actor, binding, { presets: ['community'], channels: [], excludedChannels: [], exemptRoles: [], logChannel: null, customizations: {} });
    const ref = { planId: plan.id, digest: plan.digest };
    await onboarding.transition(guild, actor, binding, ref, 'accept');
    await onboarding.transition(guild, actor, binding, ref, 'apply');
    for (const key of DATA_USE_CONSENT_KEYS) assert.equal((await reader.store.getSettings(guild)).value[key], beforeSetup[key]);
    assert.equal((await receipts()).length, count);
    administrator = false;
    assert.equal((await save({ typesafeReviewConsent: false })).status, 403);
    administrator = true;
    assert.equal((await request({ completeTechTrainingConsent: true }, 1, DATA_USE_NOTICE_VERSION, foreign)).status, 403);
    assert.equal((await request(undefined, undefined, undefined, foreign)).status, 403);
    assert.equal((await reader.store.getSettings(foreign)).value.completeTechTrainingConsent, false);
    // Old receipts expire under existing policy; settings and their revision survive maintenance.
    const beforeCleanup = await reader.store.getSettings(guild);
    await pool.query(`UPDATE audit_events SET updated_at=${kind === 'mysql' ? 'NOW(3)-INTERVAL 366 DAY' : "now()-interval '366 days'"} WHERE guild_id=${mark}`, [guild]);
    await store.maintenance(); assert.equal((await receipts()).length, 0);
    await reader.pool.end(); reader = await openDatabase(url.href);
    assert.deepEqual(await reader.store.getSettings(guild), beforeCleanup);
    await store.deleteSession(digest(session));
    await store.createSession(digest(session), { userId: actor, guildId: guild, expiresAt: Date.now() - 60_000 });
    assert.equal((await save({ typesafeReviewConsent: false })).status, 401);
    console.log(`PASS ${kind}: legacy defaults, independent transitions/readback/withdrawal, notice binding, strict booleans, SQL failure rollback, race, pack/onboarding/starter preservation, authority/isolation, retention cleanup and reopened-pool durability`);
} finally {
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const g of [guild, foreign]) await pool.query(`DELETE FROM guilds WHERE id=${mark}`, [g]);
    await reader.pool.end(); await pool.end();
}
