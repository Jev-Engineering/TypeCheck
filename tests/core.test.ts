import { timeoutPreset } from '../shared/domain.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, parseSettings, storedSettings, parseRule, baseRecord, effectiveAuthority, AppError, type RoleGrant, type Match, type Rule } from '../shared/domain.js';
import { Vault, csvCell } from '../server/security.js';
import { resolvePolicy, fingerprint } from '../server/policy.js';
import { parseJev, makeComparison, JevClient } from '../server/jev.js';
import { channelPermissions, guildPermissions, DiscordRest, parseDiscordMessage } from '../server/discord.js';
import { loadConfig, defaultObjectDir } from '../server/config.js';
import { fixture, rule, enable, G, G2, MOD, ROLE, CHANNEL, USER, PNG } from './helpers.js';
const throwsCode = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof AppError && e.code === code);
test('defaults are monitoring-only, no channels, no semantic or any-image rules', () => { assert.equal(DEFAULT_SETTINGS.enforcement, false); assert.deepEqual(DEFAULT_SETTINGS.channels, []); assert.equal(DEFAULT_SETTINGS.anyImageEnabled, false); assert.equal(DEFAULT_SETTINGS.semanticEnabled, false); });
test('settings reject unversioned model alias', () => throwsCode(() => parseSettings({ model: 'jev-latest' }), 'pin_versioned_jev_model'));
test('settings reject unknown client authority claims', () => throwsCode(() => parseSettings({ administrator: true }), 'unknown_field'));

test('legacy settings hydrate both data-use permissions as off and preserve saved independent choices', () => {
    const { typesafeReviewConsent, completeTechTrainingConsent, ...legacy } = DEFAULT_SETTINGS;
    assert.equal(storedSettings(legacy).typesafeReviewConsent, false);
    assert.equal(storedSettings(legacy).completeTechTrainingConsent, false);
    assert.equal(storedSettings({ ...legacy, typesafeReviewConsent: true }).typesafeReviewConsent, true);
    assert.equal(storedSettings({ ...legacy, typesafeReviewConsent: true }).completeTechTrainingConsent, false);
});
test('higher-severity threshold cannot be lower than timeout', () => throwsCode(() => parseSettings({ thresholds: { timeout: 0.99, kick: 0.8 } }), 'severe_threshold_must_not_be_lower'));
test('settings reject string booleans and NaN budget', () => { throwsCode(() => parseSettings({ enforcement: 'false' }), 'invalid_boolean'); throwsCode(() => parseSettings({ dailyCallLimit: NaN }), 'invalid_number'); });
test('timeout bounds include 28 days, exclude longer duration', async (t) => { const f = await fixture(t), r = rule(f.ref); const { id, guildId, revision, createdAt, updatedAt, approval, ...input } = r; assert.equal(parseRule({ ...input, timeoutSeconds: 2419200 }).timeoutSeconds, 2419200); throwsCode(() => parseRule({ ...input, timeoutSeconds: 2419201 }), 'invalid_number'); });
test('severe rule requires second check even if client asks to disable it', async (t) => { const f = await fixture(t), { id, guildId, revision, createdAt, updatedAt, approval, ...input } = rule(f.ref); assert.equal(parseRule({ ...input, action: 'ban', secondVerification: false }).secondVerification, true); });
test('review/none cannot smuggle a delete side effect', async (t) => { const f = await fixture(t), { id, guildId, revision, createdAt, updatedAt, approval, ...input } = rule(f.ref); throwsCode(() => parseRule({ ...input, action: 'review', deleteMessage: true }), 'nonpunitive_rule_cannot_delete'); });
test('group/individual targets are mutually exclusive', async (t) => { const f = await fixture(t), { id, guildId, revision, createdAt, updatedAt, approval, ...input } = rule(f.ref); throwsCode(() => parseRule({ ...input, type: 'group', groupId: randomUUID() }), 'individual_reference_required'); });
test('owner receives full capabilities without grants', () => assert.ok(effectiveAuthority({ guildId: G, userId: USER, owner: true, administrator: false, roles: [] }, []).capabilities.includes('credentials.manage')));
test('administrator receives full capabilities without grants', () => assert.ok(effectiveAuthority({ guildId: G, userId: USER, owner: false, administrator: true, roles: [] }, []).capabilities.includes('ban.enable')));
test('moderator without explicit grant has no capabilities', () => assert.deepEqual(effectiveAuthority({ guildId: G, userId: MOD, owner: false, administrator: false, roles: [ROLE] }, []).capabilities, []));
test('role grants do not leak administrator-only capabilities', () => { const grant: RoleGrant = { ...baseRecord(G, randomUUID()), roleId: ROLE, capabilities: ['images.add', 'credentials.manage'] }; assert.deepEqual(effectiveAuthority({ guildId: G, userId: MOD, owner: false, administrator: false, roles: [ROLE] }, [grant]).capabilities, ['images.add']); });
test('cross-guild role grants do not apply', () => { const grant: RoleGrant = { ...baseRecord(G2, randomUUID()), roleId: ROLE, capabilities: ['images.add'] }; assert.deepEqual(effectiveAuthority({ guildId: G, userId: MOD, owner: false, administrator: false, roles: [ROLE] }, [grant]).capabilities, []); });
test('role revocation changes effective permissions immediately', () => { const grant: RoleGrant = { ...baseRecord(G, randomUUID()), roleId: ROLE, capabilities: ['images.add'] }; assert.deepEqual(effectiveAuthority({ guildId: G, userId: MOD, owner: false, administrator: false, roles: [] }, [grant]).capabilities, []); });
test('vault uses randomized authenticated encryption and supports roundtrip', () => { const v = new Vault(randomBytes(32).toString('base64')); const a = v.encrypt(G, 'secret-api-value'), b = v.encrypt(G, 'secret-api-value'); assert.notEqual(a.ciphertext, b.ciphertext); assert.equal(v.decrypt(G, a), 'secret-api-value'); assert.ok(!JSON.stringify(a).includes('secret-api-value')); });
test('ciphertext cannot be transplanted to another guild', () => { const v = new Vault(randomBytes(32).toString('base64')); throwsCode(() => v.decrypt(G2, v.encrypt(G, 'value')), 'credential_decryption_failed'); });
test('tampered ciphertext is rejected', () => { const v = new Vault(randomBytes(32).toString('base64')); const e = v.encrypt(G, 'value'); e.tag = Buffer.alloc(16).toString('base64'); throwsCode(() => v.decrypt(G, e), 'credential_decryption_failed'); });
test('vault rejects short master key', () => throwsCode(() => new Vault('YWJj'), 'master_key_must_be_32_bytes'));
test('CSV formula cells are escaped, including whitespace prefix', () => { assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"'); assert.equal(csvCell('  @SUM(1)'), '"\'  @SUM(1)"'); assert.equal(csvCell('a"b'), '"a""b"'); });
function match(r: Rule, p = 1): Match { return { ruleId: r.id, referenceId: r.referenceId, probability: p, verified: true, model: 'jev-1.14.0', attachmentId: 'attachment' }; }
test('eligible approved match produces intended timeout', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); const d = resolvePolicy([r], [match(r)], s, [f.ref]); assert.equal(d?.execute, true); assert.equal(d?.action, 'timeout'); });
test('monitoring-only suppresses a valid match', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); s.enforcement = false; assert.equal(resolvePolicy([r], [match(r)], s, [f.ref])?.reason, 'monitoring_only'); });
test('missing approval suppresses action', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); r.approval = null; assert.equal(resolvePolicy([r], [match(r)], s, [f.ref])?.reason, 'calibration_approval_required'); });
test('reference replacement invalidates approval', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); assert.equal(resolvePolicy([r], [match(r)], s, [{ ...f.ref, sha256: 'different' }])?.reason, 'calibration_approval_required'); });
test('action-specific floor overrides lower rule threshold', async (t) => { const f = await fixture(t), r = rule(f.ref, { threshold: 0.8 }), s = await enable(f, r); const d = resolvePolicy([r], [match(r, 0.89)], s, [f.ref]); assert.equal(d?.execute, false); assert.equal(d?.action, 'review'); });
test('confident negative produces no match', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); assert.equal(resolvePolicy([r], [match(r, 0.001)], s, [f.ref]), null); });
test('uncertain result can be explicitly ignored', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); s.uncertain = 'ignore'; assert.equal(resolvePolicy([r], [match(r, 0.5)], s, [f.ref]), null); });
test('kick/ban require a completed second check', async (t) => { const f = await fixture(t), r = rule(f.ref, { action: 'ban', secondVerification: true }), s = await enable(f, r); assert.equal(resolvePolicy([r], [{ ...match(r), verified: false }], s, [f.ref])?.reason, 'verification_required'); });
test('high impact setting blocks kick/ban independently', async (t) => { const f = await fixture(t), r = rule(f.ref, { action: 'ban' }), s = await enable(f, r); s.highImpactEnabled = false; assert.equal(resolvePolicy([r], [match(r)], s, [f.ref])?.reason, 'high_impact_disabled'); });
test('semantic mode stays review-only even with approval', async (t) => { const f = await fixture(t), r = rule(f.ref, { mode: 'semantic' }), s = await enable(f, r); s.semanticEnabled = true; assert.equal(resolvePolicy([r], [match(r)], s, [f.ref])?.reason, 'semantic_review_only'); });
test('any-image mode remains disabled by default', async (t) => { const f = await fixture(t), r = rule(f.ref, { type: 'any_image', referenceId: null }), s = await enable(f, r); assert.equal(resolvePolicy([r], [match(r)], s, [f.ref]), null); });
test('individual rule precedes global rule at equal priority', async (t) => { const f = await fixture(t), individual = rule(f.ref), global = rule(f.ref, { type: 'any_match', referenceId: null, action: 'ban' }), s = await enable(f, individual); const d = resolvePolicy([global, individual], [match(global), match(individual)], s, [f.ref]); assert.equal(d?.rule.id, individual.id); });
test('explicit numeric priority overrides default precedence', async (t) => { const f = await fixture(t), individual = rule(f.ref), global = rule(f.ref, { type: 'any_match', referenceId: null, priority: 10 }), s = await enable(f, individual); assert.equal(resolvePolicy([individual, global], [match(individual), match(global)], s, [f.ref])?.rule.id, global.id); });
test('several images still resolve a single effective rule', async (t) => { const f = await fixture(t), r = rule(f.ref), s = await enable(f, r); const d = resolvePolicy([r], [match(r), { ...match(r), attachmentId: 'second' }], s, [f.ref]); assert.equal(d?.rule.id, r.id); });
test('fingerprint is independent of stored approval and timestamps', async (t) => { const f = await fixture(t), r = rule(f.ref); assert.equal(fingerprint(r, [f.ref], DEFAULT_SETTINGS), fingerprint({ ...r, revision: 99, updatedAt: 'different', approval: { actor: 'x', at: 'y', note: 'z', fingerprint: 'x' } }, [f.ref], DEFAULT_SETTINGS)); });
for (const bad of [NaN, Infinity, -1, 1.01, '0.99', null])
    test(`Jev parser rejects invalid probability ${String(bad)}`, () => throwsCode(() => parseJev({ model: 'jev-1.14.0', answers: { match: { type: 'noul', noul: bad } }, usage: { input_tokens: 1 } }, 'jev-1.14.0'), 'jev_response_schema_invalid'));
test('Jev parser rejects model drift', () => throwsCode(() => parseJev({ model: 'jev-1.13.0' }, 'jev-1.14.0'), 'jev_model_mismatch'));
test('Jev parser reads official noul field, not free-form text', () => assert.equal(parseJev({ model: 'jev-1.14.0', answers: { match: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 123 } }, 'jev-1.14.0').probability, 0.8));
test('multipart request references both images exactly once in state', () => { const r = makeComparison(PNG, PNG, 'jev-1.14.0', 'transformed'); assert.equal(r.body.get('submitted') instanceof Blob, true); assert.equal(Object.keys(r.request.assets).length, 2); assert.ok(r.request.assets[r.request.state.submitted]); assert.ok(r.request.assets[r.request.state.reference]); assert.equal(Object.values(r.request.assets).every(a => a.type === 'image'), true); });
test('Jev calls include image header and honor Retry-After with a new budget reservation', async () => {
    let calls = 0, reservations = 0;
    const waits: number[] = [];
    const http = (async (_u: unknown, init?: RequestInit) => { calls++; assert.equal((init!.headers as Record<string, string>)['TypeSafe-Danger-Zone-Images'], 'true'); return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ model: 'jev-1.14.0', answers: { match: { type: 'noul', noul: 1 } }, usage: { input_tokens: 50 } }); }) as typeof fetch;
    const r = await new JevClient(http, async (n) => { waits.push(n); }).compare(PNG, PNG, { key: 'test-only-key', mode: 'exact', model: 'jev-1.14.0', onAttempt: async () => { reservations++; } });
    assert.equal(r.probability, 1);
    assert.equal(reservations, 2);
    assert.equal(waits.length, 1);
});
test('Discord permission overwrite combines role allows after denies', () => { const g = { id: G, name: 'x', owner_id: 'owner', roles: [{ id: G, name: 'everyone', position: 0, permissions: '1024' }, { id: ROLE, name: 'r', position: 1, permissions: '0' }] }; const m = { user: { id: USER }, roles: [ROLE] }; const c = { id: CHANNEL, type: 0, permission_overwrites: [{ id: G, type: 0, deny: '1024', allow: '0' }, { id: ROLE, type: 0, deny: '0', allow: '1024' }] }; assert.equal(channelPermissions(g, m, c) & 1024n, 1024n); });
test('member-specific deny takes precedence over role allow', () => { const g = { id: G, name: 'x', owner_id: 'owner', roles: [{ id: G, name: 'everyone', position: 0, permissions: '1024' }] }; const m = { user: { id: USER }, roles: [] }; assert.equal(channelPermissions(g, m, { id: CHANNEL, type: 0, permission_overwrites: [{ id: USER, type: 1, deny: '1024', allow: '0' }] }) & 1024n, 0n); });
test('message parser does not persist message text', () => { const m = parseDiscordMessage({ guild_id: G, channel_id: CHANNEL, id: '100000000000000099', author: { id: USER }, attachments: [], content: 'not stored' }); assert.equal(JSON.stringify(m).includes('not stored'), false); });
test('Discord 204 mutation is a successful empty response', async () => { const rest = new DiscordRest('token', 'id', 'secret', (async () => new Response(null, { status: 204 })) as typeof fetch); assert.equal(await rest.request('/channels/1/messages/2', 'DELETE'), null); });
test('production rejects HTTP origin', () => throwsCode(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://localhost', DISCORD_CLIENT_ID: G }), 'production_requires_https'));
test('objects default to durable Private Storage when the host provides it', () => { assert.equal(defaultObjectDir(true), '/private/objects'); assert.equal(defaultObjectDir(false), './objects'); });


test('OAuth renewal validates application binding, identify scope and token expiration', async () => {
    let application = G, expires = new Date(Date.now() + 3600000).toISOString(), scopes = ['identify'];
    const rest = new DiscordRest('bot', G, 'secret', (async () => Response.json({application: {id: application}, user: {id: MOD}, scopes, expires})) as typeof fetch);
    assert.equal(await rest.oauthIdentity('oauth'), MOD);
    application = G2; await assert.rejects(rest.oauthIdentity('oauth'), /oauth_identity_invalid/);
    application = G; scopes = []; await assert.rejects(rest.oauthIdentity('oauth'), /oauth_identity_invalid/);
    scopes = ['identify']; expires = new Date(0).toISOString(); await assert.rejects(rest.oauthIdentity('oauth'), /oauth_identity_invalid/);
});

test('timeout duration selects matching presets and represents arbitrary durations as Custom', () => {
    for (const value of [60, 300, 600, 3600, 86400, 604800, 2419200]) assert.equal(timeoutPreset(value), String(value));
    for (const value of [1, 59, 61, 900, 2419201, NaN]) assert.equal(timeoutPreset(value), 'custom');
});

test('message reader permission checks apply live channel overwrites and private thread membership', async () => {
    let deny = '0', privateThread = false, joined = true;
    const rest = new DiscordRest('test-token', G, 'secret');
    rest.request = async (path: string) => {
        if (path === `/guilds/${G}`) return {id: G, owner_id: USER, roles: [{id: G, permissions: String(1024 + 65536)}]};
        if (path.includes('/members/')) return {user: {id: MOD}, roles: []};
        if (path.includes('/thread-members/')) return {user_id: joined ? MOD : USER};
        if (path === `/channels/${CHANNEL}` && privateThread) return {id: CHANNEL, guild_id: G, type: 12, parent_id: ROLE};
        return {id: privateThread ? ROLE : CHANNEL, guild_id: G, type: 0, permission_overwrites: [{id: MOD, type: 1, deny, allow: '0'}]};
    };
    await rest.assertCanReadMessage(G, MOD, CHANNEL);
    deny = '65536'; await assert.rejects(rest.assertCanReadMessage(G, MOD, CHANNEL), /message_read_permission_required/);
    deny = '1024'; await assert.rejects(rest.assertCanReadMessage(G, MOD, CHANNEL), /message_read_permission_required/);
    deny = '0'; privateThread = true; await rest.assertCanReadMessage(G, MOD, CHANNEL);
    joined = false; await assert.rejects(rest.assertCanReadMessage(G, MOD, CHANNEL), /message_read_permission_required/);
});
