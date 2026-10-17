import { TEXT_STARTERS } from '../shared/text-starters.js';
test('pack API enforces live administrator/guild boundary and preview-before-apply with recorded results',async t=>{
    const f=await setup(t),login=await f.login(),token=login.data.sessionToken,base='/api/g/'+G+'/packs';
    const starters=await f.request(base+'/starters','GET',undefined,token);assert.equal(starters.data.length,4);
    assert.equal((await f.request(base+'/preview','POST',{},token)).status,400);
    const pack=(await f.request(base+'/starter/image-scam-analysis','GET',undefined,token)).data;
    assert.equal((await f.request(base+'/apply','POST',{pack,options:{},token:'forged'},token)).status,409);
    const preview=await f.request(base+'/preview','POST',{pack,options:{}},token);assert.equal(preview.status,200);
    const applied=await f.request(base+'/apply','POST',{pack,options:{},token:preview.data.token},token);assert.equal(applied.status,200);assert.equal(applied.data.added,2);
    assert.equal((await f.request(base+'/apply','POST',{pack,options:{},token:preview.data.token},token)).status,409);
    const history=await f.request(base+'/history','GET',undefined,token);assert.equal(history.data.length,1);assert.match(history.data[0].status,/historical/);
    const definition=(await f.request(base+'/definitions','GET',undefined,token)).data[0];
    const edit=await f.request(base+'/definitions/'+definition.id,'PUT',{revision:definition.revision,name:'Locally edited',content:{...definition.content,positive:'Different observable policy'}},token);assert.equal(edit.status,200);
    assert.match((await f.request(base+'/history','GET',undefined,token)).data[0].status,/stale/);
    const exported=await f.request(base+'/export','POST',{complete:true},token);assert.equal(exported.status,200);assert.ok(exported.data.components.some((c:any)=>c.kind==='definitions'));
    assert.equal((await f.request('/api/g/'+G2+'/packs/starters','GET',undefined,token)).status,403);
    await f.grant(['dashboard.view']);const moderator=(await f.login('moderator-code')).data.sessionToken;
    assert.equal((await f.request(base+'/starters','GET',undefined,moderator)).status,403);
    assert.equal((await f.request(base+'/preview','POST',{pack},moderator)).status,403);
    assert.equal(f.control.calls,0);
});
import { test, type TestContext } from 'node:test';
import { CONTENT_PRESETS } from '../shared/content.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { baseRecord, type RoleGrant, type Rule, type Calibration, type ModerationEvent } from '../shared/domain.js';
import { Worker } from '../server/worker.js';
import { enable, message } from './helpers.js';
import { createHttp, type Deployment } from '../server/http.js';
import { digest } from '../server/security.js';
import { fingerprint } from '../server/policy.js';
import { fixture, rule, G, G2, ADMIN, MOD, ROLE, CHANNEL, API_KEY, PNG } from './helpers.js';
import { BOT } from './helpers.js';
const ORIGIN = 'http://localhost:3000';
test('onboarding HTTP preserves authentication, guild isolation, live authority and read-only tombstones',async t=>{
    const f=await setup(t),base=`/api/g/${G}/onboarding/`;
    assert.equal((await f.request(base+'context')).status,401);
    const login=await f.login(),token=login.data.sessionToken;
    assert.equal((await f.request(`/api/g/${G2}/onboarding/context`,'GET',undefined,token)).status,403);
    assert.equal((await f.request(base+'context','GET',undefined,token)).data.guildId,G);
    assert.ok(!(await f.request(base+'inventory','GET',undefined,token)).raw.includes('objectKey'));
    const input={presets:['scam_phishing'],channels:[CHANNEL],excludedChannels:[],exemptRoles:[],logChannel:CHANNEL,customizations:{}};
    const p=await f.request(base+'plans','POST',input,token);assert.equal(p.status,200);
    const ref={planId:p.data.id,digest:p.data.digest};
    assert.equal((await f.request(base+'apply','POST',ref,token)).status,409);
    assert.equal((await f.request(base+'accept','POST',ref,token)).status,200);
    const applied=await f.request(base+'apply','POST',ref,token);assert.equal(applied.status,200);assert.equal(applied.data.receipt.enforcement,false);
    assert.deepEqual((await f.request(base+'apply','POST',ref,token)).data.receipt,applied.data.receipt);
    const s=await f.store.getSettings(G);
    assert.equal((await f.request(`/api/g/${G}/settings`,'PUT',{value:{...s.value,onboardingStarters:[]},revision:s.revision},token)).data.error,'starter_marker_read_only');
    f.discord.members.get(ADMIN)!.administrator=false;f.discord.members.get(ADMIN)!.owner=false;
    assert.equal((await f.request(base+'context','GET',undefined,token)).status,403);
});
test('standalone OAuth uses browser-bound state and exact redirect, with no Activity SDK or tokens in redirect URLs',async t=>{
    const f=await setup(t),address=f.server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
    let redirectUri='';const exchange=f.discord.exchange.bind(f.discord);
    f.discord.exchange=async (code:string,uri?:string)=>{redirectUri=uri??'';return exchange(code);};
    const start=await f.request('/api/auth/browser/start','POST',{guildId:G});assert.equal(start.status,200);
    const auth=new URL(start.data.authorizeUrl);assert.equal(auth.searchParams.get('scope'),'identify');
    assert.equal(auth.searchParams.get('redirect_uri'),ORIGIN+'/api/auth/browser/callback');
    const cookie=start.headers.get('set-cookie')!.split(';')[0]!;
    const callback=base+'/api/auth/browser/callback?code=admin-code&state='+auth.searchParams.get('state');
    assert.equal((await fetch(callback,{redirect:'manual'})).status,401);
    const result=await fetch(callback,{redirect:'manual',headers:{Cookie:cookie}});assert.equal(result.status,303);assert.equal(redirectUri,ORIGIN+'/api/auth/browser/callback');
    assert.equal(result.headers.get('location'),'/setup');assert.ok(result.headers.get('set-cookie')!.includes('HttpOnly'));
    assert.equal((await fetch(callback,{redirect:'manual',headers:{Cookie:cookie}})).status,401);
    const bootstrap=await fetch(base+'/api/auth/browser/session',{method:'POST',headers:{Origin:ORIGIN,Cookie:result.headers.get('set-cookie')!.split(';')[0]!}});
    assert.equal(bootstrap.status,200);const session=await bootstrap.json() as any;assert.equal(session.guildId,G);assert.equal(session.accessToken,undefined);
    assert.equal((await f.request(`/api/g/${G}/me`,'GET',undefined,session.sessionToken)).status,200);
    assert.equal((await f.request('/api/auth/logout','POST',{},session.sessionToken)).status,200);
    assert.equal((await f.request(`/api/g/${G}/onboarding/context`,'GET',undefined,session.sessionToken)).status,401);
    const standalone=await f.request('/setup');assert.equal(standalone.status,200);assert.ok(standalone.raw.includes('main.js'));
});
test('standalone state cannot cross guild/browser or Discord proxy origin; moderators cannot sign in',async t=>{
    const f=await setup(t),address=f.server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
    assert.equal((await f.request('/api/auth/browser/start','POST',{guildId:G},undefined,`https://${G}.discordsays.com`)).status,403);
    const start=await f.request('/api/auth/browser/start','POST',{guildId:G}),state=new URL(start.data.authorizeUrl).searchParams.get('state');
    const cookie=start.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(base+`/api/auth/browser/callback?code=admin-code&state=${state}`,{headers:{Cookie:cookie.replace(G,G2)},redirect:'manual'})).status,401);
    assert.equal((await fetch(base+`/api/auth/browser/callback?code=moderator-code&state=${state}`,{headers:{Cookie:cookie},redirect:'manual'})).status,403);
    assert.equal((await f.request('/api/auth/browser/session','POST',{})).status,401);
});
test('historical API previews scope, starts, lists, pauses, resumes and cancels with current administrator authority',async t=>{
    const f=await setup(t);await f.store.put('rules',rule(f.ref),0);
    f.discord.members.set(BOT,{guildId:G,userId:BOT,owner:false,administrator:false,roles:[]});
    Object.assign(f.discord,{history:async()=>[]});
    const login=await f.login(),token=login.data.sessionToken,base='/api/g/'+G+'/scans';
    const payload={channels:'all',exclusions:[],budgets:{messages:10,images:10,requests:10}};
    const preview=await f.request(base+'/preview','POST',payload,token);assert.equal(preview.status,200);assert.equal(preview.data.mode,'review_only');
    assert.equal((await f.request(base,'GET',undefined,token)).data.length,0);
    const started=await f.request(base,'POST',{...payload,to:preview.data.cutoff},token);assert.equal(started.status,200);assert.equal(started.data.cutoff,preview.data.cutoff);
    const id=started.data.id;
    for(const [action,status] of [['pause','paused'],['resume','running'],['cancel','cancelled']]) {
        const response=await f.request(base+'/'+id+'/'+action,'POST',{},token);assert.equal(response.status,200);assert.equal(response.data.status,status);
    }
    await f.grant(['dashboard.view']);const mod=await f.login('moderator-code');
    assert.equal((await f.request(base,'GET',undefined,mod.data.sessionToken)).status,403);
    assert.equal((await f.request(base,'POST',{...payload,enforcement:true},token)).status,400);
    const usage=await f.request('/api/g/'+G+'/analytics/summary?correlationId='+id,'GET',undefined,token);assert.equal(usage.status,200);
});
async function setup(t: TestContext, production = false, readiness?: () => Promise<boolean>, controllerState?: () => string, deployment?: Deployment) {
    const f = await fixture(t);
    const config = { port: 3000, production, publicOrigin: ORIGIN, clientId: G, clientSecret: 'fake-secret', botToken: 'fake-token', databaseUrl: 'not-used', masterKey: 'not-used', objectDir: 'not-used', model: 'jev-1.14.0', apiOnly: true };
    const server = createHttp(f.services, config, process.cwd(), readiness, controllerState, deployment);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address() as {
        port: number;
    };
    const base = `http://127.0.0.1:${address.port}`;
    t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
    const request = async (path: string, method = 'GET', body?: unknown, session?: string, origin = ORIGIN) => {
        const response = await fetch(base + path, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const raw = await response.text();
        let data: any;
        try {
            data = JSON.parse(raw);
        }
        catch {
            data = raw;
        }
        return { status: response.status, data, raw, headers: response.headers };
    };
    const login = async (code = 'admin-code') => { const start = await request('/api/auth/start', 'POST', {}); const r = await request('/api/auth/exchange', 'POST', { code, nonce: start.data.nonce, guildId: G }); return r; };
    const grant = async (capabilities: RoleGrant['capabilities']) => { const old = (await f.store.all<RoleGrant>('grants', G))[0]; const r: RoleGrant = { ...(old ?? baseRecord(G, randomUUID())), revision: (old?.revision ?? 0) + 1, roleId: ROLE, capabilities }; await f.store.put('grants', r, old?.revision ?? 0); };
    return { ...f, server, request, login, grant };
}
test('HTTP health is public but exposes no credentials', async (t) => { const f = await setup(t); const r = await f.request('/api/health'); assert.equal(r.status, 200); assert.deepEqual(r.data, { status: 'running' }); });
test('HTTP unauthenticated guild request is denied', async (t) => { const f = await setup(t); assert.equal((await f.request(`/api/g/${G}/images`)).status, 401); });
test('HTTP rejects a mutation from an untrusted origin', async (t) => { const f = await setup(t); assert.equal((await f.request('/api/auth/start', 'POST', {}, undefined, 'https://evil.invalid')).status, 403); });
test('HTTP mutation without Origin is denied', async (t) => { const f = await setup(t); assert.equal((await f.request('/api/auth/start', 'POST', {}, undefined, '')).status, 403); });
test('HTTP accepts the exact Discord proxy origin', async (t) => { const f = await setup(t); assert.equal((await f.request('/api/auth/start', 'POST', {}, undefined, `https://${G}.discordsays.com`)).status, 200); });
test('OAuth nonce is one-use', async (t) => { const f = await setup(t); const n = await f.request('/api/auth/start', 'POST', {}); const payload = { code: 'admin-code', nonce: n.data.nonce, guildId: G }; assert.equal((await f.request('/api/auth/exchange', 'POST', payload)).status, 200); assert.equal((await f.request('/api/auth/exchange', 'POST', payload)).status, 401); });
test('Discord administrator receives a usable management session', async (t) => { const f = await setup(t); const login = await f.login(); assert.equal(login.status, 200); assert.ok(login.data.authority.capabilities.includes('credentials.manage')); assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, login.data.sessionToken)).status, 200); });
test('ungranted moderator cannot get a session', async (t) => { const f = await setup(t); assert.equal((await f.login('moderator-code')).status, 403); });
test('cross-server API access is denied for a valid session', async (t) => { const f = await setup(t); const login = await f.login(); assert.equal((await f.request(`/api/g/${G2}/images`, 'GET', undefined, login.data.sessionToken)).status, 403); });
test('revoked role membership invalidates write authority on next request', async (t) => { const f = await setup(t); await f.grant(['images.view', 'images.add']); const login = await f.login('moderator-code'); f.discord.members.get(MOD)!.roles = []; const r = await f.request(`/api/g/${G}/images`, 'POST', { name: 'x', groupId: null, enabled: true, base64: PNG.toString('base64') }, login.data.sessionToken); assert.equal(r.status, 403); });
test('member removed from guild cannot reuse the old session', async (t) => { const f = await setup(t); const login = await f.login(); f.discord.members.delete(ADMIN); assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, login.data.sessionToken)).status, 403); });
test('logout removes the opaque session', async (t) => { const f = await setup(t); const login = await f.login(); assert.equal((await f.request('/api/auth/logout', 'POST', {}, login.data.sessionToken)).status, 200); assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, login.data.sessionToken)).status, 401); });
test('expired opaque session cannot authorize a request', async (t) => { const f = await setup(t); await f.store.createSession(digest('expired'), { userId: ADMIN, guildId: G, expiresAt: Date.now() - 1000 }); assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, 'expired')).status, 401); });
test('API credential status never contains plaintext or encrypted envelope', async (t) => { const f = await setup(t); const login = await f.login(); const r = await f.request(`/api/g/${G}/credentials`, 'GET', undefined, login.data.sessionToken); assert.equal(r.status, 200); assert.equal(r.data.configured, true); assert.ok(!r.raw.includes(API_KEY)); assert.ok(!r.raw.includes('ciphertext')); });
test('moderator cannot read credential management endpoint', async (t) => { const f = await setup(t); await f.grant(['dashboard.view']); const login = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/credentials`, 'GET', undefined, login.data.sessionToken)).status, 403); });
test('moderator cannot overwrite credentials through direct API call', async (t) => { const f = await setup(t); await f.grant(['dashboard.view']); const login = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/credentials`, 'PUT', { apiKey: 'attacker-key' }, login.data.sessionToken)).status, 403); });
test('valid credential replacement rotates encrypted data without restart', async (t) => { const f = await setup(t); const login = await f.login(), before = await f.services.credential(G); const next = 'another-fake-api-key'; const r = await f.request(`/api/g/${G}/credentials`, 'PUT', { apiKey: next }, login.data.sessionToken); assert.equal(r.status, 200); const after = await f.services.credential(G); assert.equal(after!.revision, before!.revision + 1); assert.equal(f.vault.decrypt(G, after!.encrypted), next); assert.ok(!r.raw.includes(next)); });
test('invalid replacement leaves the original working credential unchanged', async (t) => { const f = await setup(t); const login = await f.login(), before = await f.services.credential(G); const r = await f.request(`/api/g/${G}/credentials`, 'PUT', { apiKey: 'invalid-key-example' }, login.data.sessionToken); assert.equal(r.status, 503); assert.deepEqual(await f.services.credential(G), before); assert.ok(!r.raw.includes('invalid-key-example')); });
test('credential removal is revision-checked', async (t) => { const f = await setup(t); const login = await f.login(); assert.equal((await f.request(`/api/g/${G}/credentials`, 'DELETE', { revision: 99 }, login.data.sessionToken)).status, 409); assert.ok(await f.services.credential(G)); });
test('credential values are absent from audit records', async (t) => { const f = await setup(t); const login = await f.login(); await f.request(`/api/g/${G}/credentials`, 'PUT', { apiKey: 'new-fake-key-example' }, login.data.sessionToken); const audit = await f.request(`/api/g/${G}/audit`, 'GET', undefined, login.data.sessionToken); assert.ok(!audit.raw.includes('new-fake-key-example')); assert.ok(!audit.raw.includes(API_KEY)); });
test('unknown frontend admin claim is rejected by settings schema', async (t) => { const f = await setup(t); const login = await f.login(); const s = await f.store.getSettings(G); assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value: { ...s.value, administrator: true }, revision: s.revision }, login.data.sessionToken)).status, 400); });
test('enabling enforcement requires explicit acknowledgement and selected channels', async (t) => { const f = await setup(t); const login = await f.login(); const s = await f.store.getSettings(G); const value = { ...s.value, enforcement: true, channels: [CHANNEL] }; assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value, revision: s.revision }, login.data.sessionToken)).status, 400); assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value, revision: s.revision, acknowledgement: 'ENABLE_AUTOMATIC_ENFORCEMENT' }, login.data.sessionToken)).status, 200); });
test('settings use optimistic revisions, preventing lost updates', async (t) => { const f = await setup(t); const login = await f.login(); const s = await f.store.getSettings(G); assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value: s.value, revision: s.revision }, login.data.sessionToken)).status, 200); assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value: s.value, revision: s.revision }, login.data.sessionToken)).status, 409); });
test('delegated pause cannot resume enforcement or modify security settings', async (t) => { const f = await setup(t); await f.grant(['enforcement.pause']); const login = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/pause`, 'POST', {}, login.data.sessionToken)).status, 200); const s = await f.store.getSettings(G); assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value: { ...s.value, enforcement: true }, revision: s.revision }, login.data.sessionToken)).status, 403); });
test('image upload persists only a normalized guild-owned object', async (t) => { const f = await setup(t); const login = await f.login(); const r = await f.request(`/api/g/${G}/images`, 'POST', { name: 'Test image', groupId: null, enabled: true, base64: PNG.toString('base64') }, login.data.sessionToken); assert.equal(r.status, 201); assert.ok(r.data.objectKey.startsWith(G + '/')); assert.equal(r.data.width, 768); assert.equal(r.data.base64, undefined); });
test('image library is isolated when a foreign image ID is requested', async (t) => { const f = await setup(t); const login = await f.login(); const r = await f.request(`/api/g/${G}/images/${randomUUID()}/content`, 'GET', undefined, login.data.sessionToken); assert.equal(r.status, 404); });
test('image metadata edits retain stable ID and increment revision', async (t) => { const f = await setup(t); const login = await f.login(); const r = await f.request(`/api/g/${G}/images/${f.ref.id}`, 'PUT', { name: 'Renamed', groupId: null, enabled: true, revision: 1 }, login.data.sessionToken); assert.equal(r.status, 200); assert.equal(r.data.id, f.ref.id); assert.equal(r.data.revision, 2); });
test('individual referenced image cannot be deleted until its rule is removed', async (t) => { const f = await setup(t); const r = rule(f.ref); await f.store.put('rules', r, 0); const login = await f.login(); assert.equal((await f.request(`/api/g/${G}/images/${f.ref.id}`, 'DELETE', { revision: 1 }, login.data.sessionToken)).status, 409); });
test('image-only moderator cannot change sanctions through the rule API', async (t) => { const f = await setup(t); await f.grant(['images.view', 'images.add', 'images.edit']); const login = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/rules`, 'POST', { rule: {} }, login.data.sessionToken)).status, 403); });
test('rule editor cannot select a ban without ban capability', async (t) => { const f = await setup(t); await f.grant(['rules.create', 'actions.change']); const login = await f.login('moderator-code'); const { id, guildId, revision, createdAt, updatedAt, approval, ...input } = rule(f.ref, { action: 'ban' }); assert.equal((await f.request(`/api/g/${G}/rules`, 'POST', { rule: input }, login.data.sessionToken)).status, 403); });
test('changing any rule content clears its old approval', async (t) => { const f = await setup(t); const r = rule(f.ref, { approval: { actor: ADMIN, at: 'test', note: 'test', fingerprint: 'test' } }); await f.store.put('rules', r, 0); const login = await f.login(); const { id, guildId, revision, createdAt, updatedAt, approval, ...input } = r; const result = await f.request(`/api/g/${G}/rules/${id}`, 'PUT', { rule: { ...input, name: 'Updated' }, revision }, login.data.sessionToken); assert.equal(result.status, 200); assert.equal(result.data.approval, null); });
test('direct test API cannot execute moderation actions', async (t) => { const f = await setup(t); const r = rule(f.ref); await f.store.put('rules', r, 0); const login = await f.login(); const result = await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', { base64: PNG.toString('base64'), expected: true }, login.data.sessionToken); assert.equal(result.status, 200); assert.equal(result.data.executed, false); assert.equal(f.discord.performed.length, 0); });
test('rule approval without labeled examples is rejected', async (t) => { const f = await setup(t); const r = rule(f.ref); await f.store.put('rules', r, 0); const login = await f.login(); const result = await f.request(`/api/g/${G}/rules/${r.id}/approve`, 'POST', { note: 'I reviewed representative data and remaining risks.' }, login.data.sessionToken); assert.equal(result.status, 400); assert.equal(result.data.error, 'more_labeled_examples_required'); });
test('conflicting labels for the same sample cannot satisfy calibration', async (t) => { const f = await setup(t); const r = rule(f.ref); await f.store.put('rules', r, 0); const settings = (await f.store.getSettings(G)).value; for (const expected of [true, false]) {
    const c: Calibration = { ...baseRecord(G, randomUUID()), ruleId: r.id, fingerprint: fingerprint(r, [f.ref], settings), model: settings.model, expected, predicted: expected, probability: expected ? 1 : 0, sampleSha256: 'same-hash', actor: ADMIN };
    await f.store.put('calibrations', c, 0);
} await assert.rejects(f.services.approveRule(G, ADMIN, r.id, 'Reviewed examples and residual risk.'), /conflicting_calibration_labels/); });
test('a false-positive calibration result blocks approval', async (t) => { const f = await setup(t); const r = rule(f.ref); await f.store.put('rules', r, 0); const settings = (await f.store.getSettings(G)).value; for (const expected of [true, false]) {
    const c: Calibration = { ...baseRecord(G, randomUUID()), ruleId: r.id, fingerprint: fingerprint(r, [f.ref], settings), model: settings.model, expected, predicted: true, probability: 1, sampleSha256: String(expected), actor: ADMIN };
    await f.store.put('calibrations', c, 0);
} await assert.rejects(f.services.approveRule(G, ADMIN, r.id, 'Reviewed examples and residual risk.'), /calibration_failed/); });
test('false positive annotation disables the associated rule and clears approval', async (t) => { const f = await setup(t); const r = rule(f.ref); await f.store.put('rules', r, 0); const e: ModerationEvent = { ...baseRecord(G, randomUUID()), messageId: '100000000000000101', channelId: CHANNEL, userId: MOD, ruleId: r.id, intended: 'timeout', actual: 'suppressed', reason: 'test', matches: [], reviewStatus: 'open' }; await f.store.put('events', e, 0); const login = await f.login(); assert.equal((await f.request(`/api/g/${G}/events/${e.id}/review`, 'POST', { status: 'false_positive', revision: 1 }, login.data.sessionToken)).status, 200); assert.equal((await f.store.get<Rule>('rules', G, r.id))!.enabled, false); assert.equal(f.discord.performed.length, 0); });
test('moderator cannot grant themselves more capabilities', async (t) => { const f = await setup(t); await f.grant(['moderators.delegate', 'images.view']); const login = await f.login('moderator-code'); const grant = (await f.store.all<RoleGrant>('grants', G))[0]!; const r = await f.request(`/api/g/${G}/grants/${ROLE}`, 'PUT', { capabilities: ['images.view', 'images.add'], revision: grant.revision }, login.data.sessionToken); assert.equal(r.status, 403); });
test('administrator-only capabilities cannot be inserted in a role grant', async (t) => { const f = await setup(t); const login = await f.login(); const r = await f.request(`/api/g/${G}/grants/${ROLE}`, 'PUT', { capabilities: ['credentials.manage'], revision: 0 }, login.data.sessionToken); assert.equal(r.status, 400); });
test('CSV export is a separate delegated capability', async (t) => { const f = await setup(t); await f.grant(['logs.view']); const login = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/events/export`, 'GET', undefined, login.data.sessionToken)).status, 403); });
test('unexpected backend errors never echo secrets', async (t) => { const f = await setup(t); const login = await f.login(); f.services.credentialStatus = async () => { throw new Error(API_KEY); }; const r = await f.request(`/api/g/${G}/credentials`, 'GET', undefined, login.data.sessionToken); assert.equal(r.status, 500); assert.equal(r.data.error, 'internal_error'); assert.ok(!r.raw.includes(API_KEY)); });
test('durable action ledger is visible only with log permission', async (t) => { const f = await setup(t); await f.store.beginAction({ guildId: G, messageId: '100000000000000111', slot: 'user', action: 'ban', status: 'unknown', detail: 'network_unknown', createdAt: new Date().toISOString() }); await f.grant(['images.view']); const denied = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/actions`, 'GET', undefined, denied.data.sessionToken)).status, 403); const allowed = await f.login(); const result = await f.request(`/api/g/${G}/actions`, 'GET', undefined, allowed.data.sessionToken); assert.equal(result.status, 200); assert.equal(result.data.items[0].status, 'unknown'); });
test('durable action ledger cannot expose another guild records', async (t) => { const f = await setup(t); await f.store.beginAction({ guildId: G2, messageId: '100000000000000111', slot: 'user', action: 'ban', status: 'unknown', detail: 'other_guild', createdAt: new Date().toISOString() }); const login = await f.login(); const r = await f.request(`/api/g/${G}/actions`, 'GET', undefined, login.data.sessionToken); assert.equal(r.data.items.length, 0); });


test('production enforcement requires deployment acceptance even for an administrator', async t => {
    const f = await setup(t, true), login = await f.login();
    const settings = await f.store.getSettings(G);
    const response = await f.request(`/api/g/${G}/settings`, 'PUT', {value: {...settings.value, channels: [CHANNEL], enforcement: true}, revision: settings.revision, acknowledgement: 'ENABLE_AUTOMATIC_ENFORCEMENT'}, login.data.sessionToken);
    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'deployment_acceptance_required');
    assert.equal((await f.store.getSettings(G)).value.enforcement, false);
});
test('readiness reports dependency failure without leaking error text', async t => {
    let available = true;
    const f = await setup(t, false, async () => { if (!available) throw new Error('secret database connection'); return true; });
    assert.equal((await f.request('/api/ready')).status, 200);
    available = false;
    const response = await f.request('/api/ready');
    assert.equal(response.status, 503);
    assert.deepEqual(response.data, {status: 'not_ready'});
    assert.equal((await f.request('/api/health')).status, 200);
});

test('standby serves health and authenticated API without requiring a Gateway', async t => {
    const f = await setup(t, false, async () => true, () => 'standby');
    assert.deepEqual((await f.request('/api/health')).data, { status: 'standby' });
    const ready = await f.request('/api/ready'); assert.equal(ready.status, 200);
    assert.equal(ready.data.controller, 'standby');
    const login = await f.login(); assert.equal(login.status, 200);
    assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, login.data.sessionToken)).status, 200);
});


test('analytics permission, tenant, range, pricing revision and audit boundaries', async t => {
    const f=await setup(t);await f.grant(['dashboard.view']);const mod=(await f.login('moderator-code')).data.sessionToken;
    const path=`/api/g/${G}/analytics`;
    assert.equal((await f.request(path+'/summary','GET',undefined,mod)).status,200);
    assert.equal((await f.request(`/api/g/${G2}/analytics/summary`,'GET',undefined,mod)).status,403);
    const rate={model:'jev-1.14.0',revision:0,currency:'USD',perMillion:'2.500000',effectiveAt:'2020-01-01T00:00:00.000Z',note:'Synthetic operator rate'};
    assert.equal((await f.request(path+'/pricing','PUT',rate,mod)).status,403);
    const admin=(await f.login()).data.sessionToken;
    assert.equal((await f.request(path+'/pricing','PUT',rate,admin,'')).status,403);
    assert.equal((await f.request(path+'/pricing','PUT',rate,admin,'https://evil.invalid')).status,403);
    assert.equal((await f.request(path+'/pricing','PUT',rate,admin)).status,200);
    assert.equal((await f.request(path+'/pricing','PUT',rate,admin)).status,409);
    assert.equal((await f.store.all<any>('audit',G)).filter(r=>r.event==='pricing.updated').length,1);
    for(const params of ['limit=101','group=invalid','purpose=invalid','verification=bad','range=custom&start=2026-01-01&end=2026-12-01','before=bad']) assert.equal((await f.request(path+'/attempts?'+params,'GET',undefined,mod)).status,400);
    assert.equal((await f.request(path+'/export','GET',undefined,mod)).status,200);
    await f.grant(['images.view']);assert.equal((await f.request(path+'/summary','GET',undefined,mod)).status,403);
});

test('analytics CSV export is bounded, cursor paginated and formula safe',async t=>{
    const f=await setup(t),session=(await f.login()).data.sessionToken;
    await f.services.testCredential(G);await f.services.testCredential(G);
    const row=[...f.store.analytics.records.values()][0]!;row.model='=HYPERLINK("bad")';
    const p=`/api/g/${G}/analytics/export?limit=1`;
    const first=await f.request(p,'GET',undefined,session);assert.equal(first.status,200);assert.equal(first.raw.split('\r\n').length,2);assert.ok(first.headers.get('x-next-before'));
    const cursor=new URLSearchParams({before:first.headers.get('x-next-before')!,beforeId:first.headers.get('x-next-before-id')!});
    const second=await f.request(p+'&'+cursor,'GET',undefined,session);assert.equal(second.status,200);assert.equal(second.headers.get('x-next-before'),null);
    assert.ok((first.raw+second.raw).includes("'="));assert.ok(!(first.raw+second.raw).includes(API_KEY));
});

test('threshold API round trips custom/legacy values and preserves omitted values', async t => {
    const f = await setup(t), login = await f.login(), token = login.data.sessionToken;
    const s = await f.store.getSettings(G);
    const thresholds = { none: .95, review: .8, warn: .97, delete: .97, timeout: .99, kick: .999, ban: .999 };
    assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value: { thresholds }, revision: s.revision }, token)).status, 200);
    const saved = await f.request(`/api/g/${G}/settings`, 'GET', undefined, token);
    assert.deepEqual(saved.data.value.thresholds, thresholds);
    const changed = await f.request(`/api/g/${G}/settings`, 'PUT', { value: { thresholds: { review: .812345 } }, revision: saved.data.revision }, token);
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.data.value.thresholds, { ...thresholds, review: .812345 });
    assert.equal(changed.data.value.enforcement, false);
    const { id, guildId, revision, createdAt, updatedAt, approval, threshold, ...input } = rule(f.ref);
    const created = await f.request(`/api/g/${G}/rules`, 'POST', { rule: input }, token);
    assert.equal(created.status, 201); assert.equal(created.data.threshold, .7);
    const edit = await f.request(`/api/g/${G}/rules/${created.data.id}`, 'PUT', { rule: { ...input, threshold: .98765 }, revision: 1 }, token);
    assert.equal(edit.status, 200); assert.equal(edit.data.threshold, .98765);
    const omit = await f.request(`/api/g/${G}/rules/${created.data.id}`, 'PUT', { rule: input, revision: 2 }, token);
    assert.equal(omit.status, 200); assert.equal(omit.data.threshold, .98765);
    const loaded = await f.request(`/api/g/${G}/rules`, 'GET', undefined, token);
    assert.equal(loaded.data.find((r: Rule) => r.id === created.data.id).threshold, .98765);
});
test('threshold edits clear approval; floor-only reads do not expand settings permissions', async t => {
    const f = await setup(t), login = await f.login(), token = login.data.sessionToken;
    const r = rule(f.ref, { approval: { actor: ADMIN, at: 'test', note: 'test', fingerprint: 'test' } });
    await f.store.put('rules', r, 0);
    const { id, guildId, revision, createdAt, updatedAt, approval, ...input } = r;
    const edit = await f.request(`/api/g/${G}/rules/${id}`, 'PUT', { rule: { ...input, threshold: .75 }, revision }, token);
    assert.equal(edit.status, 200); assert.equal(edit.data.approval, null);
    await f.grant(['rules.create']);
    const mod = (await f.login('moderator-code')).data.sessionToken;
    const floors = await f.request(`/api/g/${G}/match-thresholds`, 'GET', undefined, mod);
    assert.equal(floors.status, 200); assert.equal(floors.data.timeout, .9);
    assert.equal(floors.data.enforcement, undefined);
    assert.equal((await f.request(`/api/g/${G}/settings`, 'GET', undefined, mod)).status, 403);
    assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { value: { thresholds: { review: .6 } }, revision: 1 }, mod)).status, 403);
    await f.grant([]);
    assert.equal((await f.request(`/api/g/${G}/match-thresholds`, 'GET', undefined, mod)).status, 403);
});
test('API rejects invalid thresholds and reversed severity floors without saving', async t => {
    const f = await setup(t), token = (await f.login()).data.sessionToken;
    const s = await f.store.getSettings(G);
    for (const value of [null, '0.7', .49, 1.01]) {
        const response = await f.request(`/api/g/${G}/settings`, 'PUT', { value: { thresholds: { review: value } }, revision: s.revision }, token);
        assert.equal(response.status, 400); assert.match(response.data.error, /match_threshold_must_be_a_finite_number/);
    }
    const reversed = await f.request(`/api/g/${G}/settings`, 'PUT', { value: { thresholds: { timeout: .95 } }, revision: s.revision }, token);
    assert.equal(reversed.status, 400); assert.equal(reversed.data.error, 'severe_threshold_must_not_be_lower');
    assert.deepEqual(await f.store.getSettings(G), s);
});

test('review-band worker result reaches moderator HTTP workflow without a punitive action', async t => {
    const f = await setup(t);
    await enable(f, rule(f.ref, { secondVerification: true, deleteMessage: true }));
    // A second check can reduce an action candidate into the configured review band.
    f.control.probability = 1; f.control.secondProbability = 0.8;
    const m = message(); f.discord.messages.set(m.messageId, m);
    await new Worker(f.services, async () => f.image).process(m);
    assert.equal(f.control.calls, 2);
    await f.grant(['logs.view', 'rules.edit']);
    const login = await f.login('moderator-code'), token = login.data.sessionToken;
    const listed = await f.request(`/api/g/${G}/events`, 'GET', undefined, token);
    assert.equal(listed.status, 200); assert.equal(listed.data.items.length, 1);
    const event = listed.data.items[0];
    assert.equal(event.intended, 'review'); assert.equal(event.actual, 'suppressed');
    assert.equal(event.reason, 'uncertain'); assert.equal(event.reviewStatus, 'open');
    assert.equal(event.matches[0].probability, 0.8); assert.equal(event.matches[0].verified, false);
    const reviewed = await f.request(`/api/g/${G}/events/${event.id}/review`, 'POST', { status: 'confirmed', revision: event.revision }, token);
    assert.equal(reviewed.status, 200); assert.equal(reviewed.data.reviewStatus, 'confirmed');
    assert.equal((await f.store.get<ModerationEvent>('events', G, event.id))?.reviewStatus, 'confirmed');
    assert.equal(f.discord.performed.length, 0); assert.equal(f.discord.notifications.length, 0);
    const actions = await f.request(`/api/g/${G}/actions`, 'GET', undefined, token);
    assert.deepEqual(actions.data.items, []);
});

test('settings API round trips review thresholds above action floors without rejecting stored settings', async t => {
    const f = await setup(t), login = await f.login();
    const old = await f.store.getSettings(G);
    const updated = await f.request(`/api/g/${G}/settings`, 'PUT', { value: { ...old.value, thresholds: { ...old.value.thresholds, review: 1 } }, revision: old.revision }, login.data.sessionToken);
    assert.equal(updated.status, 200);
    const read = await f.request(`/api/g/${G}/settings`, 'GET', undefined, login.data.sessionToken);
    assert.equal(read.data.value.thresholds.review, 1);
});

test('hash upload provenance is server-derived and preserved by metadata edits; test API reports no model or usage', async t => {
    const f = await setup(t), token = (await f.login()).data.sessionToken;
    const body = {name:'Synthetic hash reference',groupId:null,enabled:true,base64:PNG.toString('base64')};
    assert.equal((await f.request(`/api/g/${G}/images`,'POST',{...body,hashVersion:'forged'},token)).status,400);
    const created=await f.request(`/api/g/${G}/images`,'POST',body,token);
    assert.equal(created.status,201);assert.equal(created.data.hashVersion,f.image.hashVersion);
    const edited=await f.request(`/api/g/${G}/images/${created.data.id}`,'PUT',{name:'Renamed',groupId:null,enabled:true,revision:1},token);
    assert.equal(edited.status,200);assert.equal(edited.data.hashVersion,created.data.hashVersion);
    const r=rule(edited.data);await f.store.put('rules',r,0);
    const result=await f.request(`/api/g/${G}/rules/${r.id}/test`,'POST',{base64:PNG.toString('base64'),expected:true},token);
    assert.equal(result.status,200);assert.equal(result.data.probability,null);assert.equal(result.data.hashComparisons,1);
    assert.equal(result.data.matches[0].model,null);assert.equal(result.data.matches[0].provenance,'exact_hash');assert.equal(f.control.calls,0);
    assert.equal((await f.store.usage(G)).calls,0);assert.equal(f.discord.performed.length,0);
});

test('health reports the deployed release and storage marker without credentials', async t => {
    const commit = 'a'.repeat(40);
    const f = await setup(t, false, async () => true, () => 'leader', { release: { commit, run: '1-1', migrate: false }, storage: 'b'.repeat(32) });
    assert.deepEqual((await f.request('/api/health')).data, { status: 'leader', release: commit, storage: 'b'.repeat(32) });
});

test('the page references release-scoped assets that resolve to the current build', async t => {
    const commit = '0123456789abcdef'.repeat(2) + '01234567';
    const f = await setup(t, false, undefined, undefined, { release: { commit, run: null, migrate: false }, storage: null });
    const page = await f.request('/', 'GET', undefined, undefined, '');
    assert.equal(page.status, 200);
    assert.match(page.raw, /href="\/r\/0123456789ab\/style\.css"/);
    assert.match(page.raw, /src="\/r\/0123456789ab\/activity\/src\/main\.js"/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const css = await f.request('/r/0123456789ab/style.css', 'GET', undefined, undefined, '');
    assert.equal(css.status, 200);
    assert.equal(css.raw, await (await import('node:fs/promises')).readFile('activity/style.css', 'utf8'));
    assert.equal((await f.request('/r/0123456789ab/.env', 'GET', undefined, undefined, '')).status, 404);
    assert.equal((await f.request('/r/zzzzzzzzzzzz/style.css', 'GET', undefined, undefined, '')).status, 404);
    assert.equal((await f.request('/r/ffffffffffff/style.css', 'GET', undefined, undefined, '')).status, 404);
    assert.equal((await f.request('/r/dev/style.css', 'GET', undefined, undefined, '')).status, 404);
});

test('terms and privacy pages are public and use the release-scoped stylesheet', async t => {
    const commit = '0123456789abcdef'.repeat(2) + '01234567';
    const f = await setup(t, false, undefined, undefined, { release: { commit, run: null, migrate: false }, storage: null });
    for (const [path, title] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']] as const) {
        const page = await f.request(path, 'GET', undefined, undefined, '');
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
        assert.match(page.raw, new RegExp(`<h1>${title}</h1>`));
        assert.match(page.raw, /href="\/r\/0123456789ab\/legal\.css"/);
    }
    const css = await f.request('/r/0123456789ab/legal.css', 'GET', undefined, undefined, '');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
});

test('development pages use the dev asset scope', async t => {
    const f = await setup(t);
    assert.match((await f.request('/', 'GET', undefined, undefined, '')).raw, /src="\/r\/dev\/activity\/src\/main\.js"/);
});

test('content API starts monitoring, validates definitions, enforces permissions and guild isolation', async t => {
    const f = await setup(t), admin = await f.login(), token = admin.data.sessionToken;
    const { id, guildId, revision, createdAt, updatedAt, approval, ...input } = rule(f.ref, { type: 'content', referenceId: null, content: structuredClone(CONTENT_PRESETS[0]!.definition) });
    const created = await f.request(`/api/g/${G}/rules`, 'POST', { rule: input }, token);
    assert.equal(created.status, 201); assert.equal(created.data.automatic, false); assert.equal(created.data.approval, null);
    const invalid = await f.request(`/api/g/${G}/rules`, 'POST', { rule: { ...input, content: { ...input.content, unsupported: true } } }, token);
    assert.equal(invalid.status, 400);
    const foreign = await f.request(`/api/g/${G2}/rules/${created.data.id}`, 'PUT', { rule: input, revision: 1 }, token);
    assert.equal(foreign.status, 403);
    await f.grant(['rules.view']);
    const mod = await f.login('moderator-code');
    assert.equal((await f.request(`/api/g/${G}/rules`, 'POST', { rule: input }, mod.data.sessionToken)).status, 403);
    assert.equal((await f.request(`/api/g/${G}/content-presets`, 'GET', undefined, token)).data.length, 13);
    const stale = await f.request(`/api/g/${G}/rules/${created.data.id}`, 'PUT', { rule: input, revision: 9 }, token);
    assert.equal(stale.status, 409);
    const hugeContext = await f.request(`/api/g/${G}/rules/${created.data.id}/test`, 'POST', { base64: PNG.toString('base64'), context: 'x'.repeat(2001) }, token);
    assert.equal(hugeContext.status, 400);
    const module = await f.request('/shared/content.js'); assert.equal(module.status, 200);
});

test('content rule capacity is enforced transactionally on creation and enabling', async t => {
    const f = await setup(t), token = (await f.login()).data.sessionToken;
    const { id, guildId, revision, createdAt, updatedAt, approval, ...input } = rule(f.ref, { type: 'content', referenceId: null, content: structuredClone(CONTENT_PRESETS[0]!.definition) });
    const saved = [];
    for (let i = 0; i < 8; i++) {
        const response = await f.request(`/api/g/${G}/rules`, 'POST', { rule: input }, token);
        assert.equal(response.status, 201); saved.push(response.data);
    }
    const blocked = await f.request(`/api/g/${G}/rules`, 'POST', { rule: input }, token);
    assert.equal(blocked.status, 400); assert.equal(blocked.data.error, 'content_active_rule_limit');
    const dormant = await f.request(`/api/g/${G}/rules`, 'POST', { rule: { ...input, enabled: false } }, token);
    assert.equal(dormant.status, 201);
    const enable = await f.request(`/api/g/${G}/rules/${dormant.data.id}`, 'PUT', { rule: input, revision: 1 }, token);
    assert.equal(enable.status, 400); assert.equal(enable.data.error, 'content_active_rule_limit');
    assert.equal((await f.store.get<Rule>('rules', G, dormant.data.id))!.revision, 1);
    const edit = await f.request(`/api/g/${G}/rules/${saved[0].id}`, 'PUT', { rule: { ...input, name: 'Updated at capacity' }, revision: 1 }, token);
    assert.equal(edit.status, 200);
    assert.equal((await f.request(`/api/g/${G}/rules/${saved[0].id}`, 'PUT', { rule: { ...input, enabled: false }, revision: 2 }, token)).status, 200);
    assert.equal((await f.request(`/api/g/${G}/rules/${dormant.data.id}`, 'PUT', { rule: input, revision: 1 }, token)).status, 200);
});

test('retesting a negative sample cannot hide a false positive from approval', async t => {
    for (const type of ['individual', 'content'] as const) {
        for (const predictions of [[true, false], [false, true]]) {
            const f = await setup(t);
            const r = rule(f.ref, { action: 'warn', type, ...(type === 'content' ? { referenceId: null, content: structuredClone(CONTENT_PRESETS[0]!.definition) } : {}) });
            await f.store.put('rules', r, 0);
            const settings = (await f.store.getSettings(G)).value;
            for (const [i, predicted] of [true, ...predictions].entries()) {
                const c: Calibration = { ...baseRecord(G, randomUUID()), ruleId: r.id, fingerprint: fingerprint(r, [f.ref], settings), model: settings.model, expected: i === 0, predicted, probability: predicted ? 1 : 0, sampleSha256: i === 0 ? 'positive' : 'negative', actor: ADMIN };
                await f.store.put('calibrations', c, 0);
            }
            await assert.rejects(f.services.approveRule(G, ADMIN, r.id, 'Reviewed examples and residual risk.'), /calibration_failed/);
            assert.equal((await f.store.get<Rule>('rules', G, r.id))!.approval, null);
        }
    }
});


test('renewal replaces an expired app session using a live OAuth identity and one-use nonce', async t => {
    const f = await setup(t); const initial = await f.login();
    await f.store.createSession(digest(initial.data.sessionToken), {userId: ADMIN, guildId: G, expiresAt: Date.now() - 1});
    assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, initial.data.sessionToken)).status, 401);
    const nonce = (await f.request('/api/auth/start', 'POST', {})).data.nonce;
    const payload = {accessToken: 'fake-oauth-token', nonce, guildId: G};
    const renewed = await f.request('/api/auth/renew', 'POST', payload);
    assert.equal(renewed.status, 200); assert.notEqual(renewed.data.sessionToken, initial.data.sessionToken);
    assert.equal(renewed.data.accessToken, undefined); assert.equal(renewed.data.expiresIn, 900);
    assert.equal((await f.request(`/api/g/${G}/me`, 'GET', undefined, renewed.data.sessionToken)).status, 200);
    assert.equal((await f.request('/api/auth/renew', 'POST', payload)).status, 401);
});

test('renewal rejects invalid identity, wrong guild and revoked authority', async t => {
    const f = await setup(t);
    const renew = async (accessToken: string, guildId = G) => f.request('/api/auth/renew', 'POST', {accessToken, guildId, nonce: (await f.request('/api/auth/start', 'POST', {})).data.nonce});
    assert.equal((await renew('expired-oauth-token')).status, 401);
    assert.equal((await renew('fake-oauth-token', G2)).status, 403);
    f.discord.members.delete(ADMIN);
    assert.equal((await renew('fake-oauth-token')).status, 403);
});

test('message calibration rejects cross-guild links and missing live permissions', async t => {
    const f = await setup(t), r = rule(f.ref); await f.store.put('rules', r, 0);
    const admin = (await f.login()).data.sessionToken;
    const path = `/api/g/${G}/rules/${r.id}/test`;
    assert.equal((await f.request(path, 'POST', {messageUrl: `https://discord.com/channels/${G2}/${CHANNEL}/100000000000000201`}, admin)).data.error, 'message_wrong_guild');
    await f.grant(['images.view']); const mod = (await f.login('moderator-code')).data.sessionToken;
    assert.equal((await f.request(path, 'POST', {messageUrl: `https://discord.com/channels/${G}/${CHANNEL}/100000000000000201`}, mod)).status, 403);
    f.discord.allow = false;
    assert.equal((await f.request(path, 'POST', {messageUrl: `https://discord.com/channels/${G}/${CHANNEL}/100000000000000201`}, admin)).data.error, 'message_read_permission_required');
});

test('message calibration reports not found, no images and oversized attachments without Jev calls', async t => {
    const f = await setup(t), r = rule(f.ref); await f.store.put('rules', r, 0);
    const session = (await f.login()).data.sessionToken, m = message();
    const path = `/api/g/${G}/rules/${r.id}/test`, body = {messageUrl: `https://discord.com/channels/${G}/${CHANNEL}/${m.messageId}`, expected: true};
    assert.equal((await f.request(path, 'POST', body, session)).data.error, 'message_not_found');
    f.discord.messages.set(m.messageId, {...m, attachments: []});
    assert.equal((await f.request(path, 'POST', body, session)).data.error, 'message_has_no_supported_images');
    f.discord.messages.set(m.messageId, {...m, attachments: [{...m.attachments[0]!, size: 8 * 1024 * 1024 + 1}]});
    assert.equal((await f.request(path, 'POST', body, session)).data.error, 'image_byte_limit');
    assert.equal(f.control.calls, 0);
});

test('library calibration is guild scoped, permission checked and explains exact_hash exclusion', async t => {
    const f = await setup(t);
    const ref = {...f.ref, hashVersion: f.image.hashVersion, revision: 2}; await f.store.put('images', ref, 1);
    const r = rule(ref); await f.store.put('rules', r, 0);
    const path = `/api/g/${G}/rules/${r.id}/test`, session = (await f.login()).data.sessionToken;
    const other = {...ref, ...baseRecord(G2, randomUUID())}; await f.store.put('images', other, 0);
    assert.equal((await f.request(path, 'POST', {imageIds: [other.id]}, session)).status, 404);
    await f.grant(['matching.test']); const mod = (await f.login('moderator-code')).data.sessionToken;
    assert.equal((await f.request(path, 'POST', {imageIds: [ref.id]}, mod)).status, 403);
    const result = await f.request(path, 'POST', {imageIds: [ref.id, ref.id], expected: true}, session);
    assert.equal(result.status, 200); assert.equal(result.data.results.length, 1);
    assert.match(result.data.results[0].calibrationNote, /exact_hash.*do not count/);
    assert.equal(f.control.calls, 0);
    assert.equal((await f.store.all<Calibration>('calibrations', G))[0]!.sampleSha256, ref.sha256);
    await assert.rejects(f.services.approveRule(G, ADMIN, r.id, 'Reviewed representative examples.'), /more_labeled_examples_required/);
});


test('message attachments use real normalization, calibration and provider accounting', async t => {
    const f = await setup(t), r = rule(f.ref); await f.store.put('rules', r, 0);
    const m = message(); f.discord.messages.set(m.messageId, m);
    const session = (await f.login()).data.sessionToken;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(url).startsWith('https://cdn.discordapp.com/')) {
            assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
            return new Response(new Uint8Array(PNG));
        }
        return originalFetch(url, init);
    }) as typeof fetch);
    const result = await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', {messageUrl: `https://discord.com/channels/${G}/${CHANNEL}/${m.messageId}`, expected: true}, session);
    assert.equal(result.status, 200); assert.equal(result.data.results.length, 1);
    assert.equal(f.control.calls, 1); assert.equal((await f.store.usage(G)).calls, 1);
    const samples = await f.store.all<Calibration>('calibrations', G);
    assert.equal(samples[0]!.sampleSha256, f.image.sha256);
    assert.equal(f.discord.performed.length, 0);
});

test('native text API is guild-scoped, requires testing capability and never enforces even approved text', async (t) => { const f = await setup(t); const r = rule(f.ref, { type: 'text', referenceId: null, text: TEXT_STARTERS[0]!.definition }); await enable(f, r); const login = await f.login(); const session = login.data.sessionToken; const out = await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', { text: 'Synthetic fee request', expected: true }, session); assert.equal(out.status, 200); assert.equal(out.data.executed, false); assert.equal(out.data.status, 'detected'); assert.ok(!out.raw.includes('Synthetic fee request')); assert.equal(f.discord.performed.length, 0); assert.equal((await f.request(`/api/g/${G2}/rules/${r.id}/test`, 'POST', { text: 'test' }, session)).status, 403); await f.grant(['dashboard.view']); const mod = await f.login('moderator-code'); assert.equal((await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', { text: 'test' }, mod.data.sessionToken)).status, 403); });
test('authorized same-guild text test links refetch only that message and reject inaccessible or cross-guild links', async (t) => { const f = await setup(t); const r = rule(f.ref, { type: 'text', referenceId: null, text: TEXT_STARTERS[0]!.definition }); await enable(f, r); const m = { ...message(), attachments: [], content: 'Transient same-guild sample' }; f.discord.messages.set(m.messageId, m); const session = (await f.login()).data.sessionToken; const url = `https://discord.com/channels/${G}/${CHANNEL}/${m.messageId}`; const out = await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', { messageUrl: url }, session); assert.equal(out.status, 200); assert.equal(out.data.executed, false); assert.ok(!out.raw.includes(m.content)); assert.equal(f.discord.performed.length, 0); f.discord.allow = false; assert.equal((await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', { messageUrl: url }, session)).status, 403); assert.equal((await f.request(`/api/g/${G}/rules/${r.id}/test`, 'POST', { messageUrl: url.replace(G, G2) }, session)).status, 403); });
test('text test validation rejects unsupported sources and empty text yields explicit abstention', async (t) => { const f = await setup(t); const r = rule(f.ref, { type: 'text', referenceId: null, text: TEXT_STARTERS[0]!.definition }); await enable(f, r); const session = (await f.login()).data.sessionToken; const route = `/api/g/${G}/rules/${r.id}/test`; for (const body of [{ text: 'x', base64: PNG.toString('base64') }, { text: 3 }, { text: 'sample', context: 'Untrusted extra policy-relevant context' }, { base64: PNG.toString('base64') }])
    assert.equal((await f.request(route, 'POST', body, session)).status, 400); const out = await f.request(route, 'POST', { text: '' }, session); assert.equal(out.status, 200); assert.equal(out.data.status, 'insufficient_evidence'); assert.equal(f.control.calls, 0); assert.equal(f.discord.performed.length, 0); });
test('text starters require admin installation and marker cannot be reset through settings', async (t) => { const f = await setup(t); const session = (await f.login()).data.sessionToken; const out = await f.request(`/api/g/${G}/text-starters/install`, 'POST', {}, session); assert.equal(out.status, 200); assert.equal(out.data.installed, 10); assert.equal((await f.request(`/api/g/${G}/text-starters/install`, 'POST', {}, session)).data.installed, 0); const settings = await f.store.getSettings(G); assert.equal((await f.request(`/api/g/${G}/settings`, 'PUT', { revision: settings.revision, value: { ...settings.value, textStartersInstalled: false } }, session)).status, 400); await f.grant(['rules.view', 'rules.create', 'rules.edit', 'actions.change']); const mod = (await f.login('moderator-code')).data.sessionToken; assert.equal((await f.request(`/api/g/${G}/text-starters`, 'GET', undefined, mod)).status, 200); assert.equal((await f.request(`/api/g/${G}/text-starters/install`, 'POST', {}, mod)).status, 403); });
