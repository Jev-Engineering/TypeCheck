import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { utimes, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, G, G2, ADMIN, MOD, BOT, CHANNEL, ROLE, API_KEY, rule } from './helpers.js';
import { Packs, exportPack, packDigest, validatePack } from '../server/packs.js';
import { starterPack } from '../server/pack-starters.js';
import { seedStarterReferences } from '../server/starter-references.js';
import { baseRecord, type Rule, type ReferenceImage } from '../shared/domain.js';
import { PACK_LIMITS, type Pack, type ImportOptions } from '../shared/packs.js';
import { PNG } from './helpers.js';
import { TEXT_STARTERS } from '../shared/text-starters.js';
test('complete export supports full destination component and channel/role capacities',async t=>{
    const f=await fixture(t),template=await starterPack(process.cwd(),'custom-template'),definition=template.components.find(c=>c.kind==='definitions')!.value.content;
    for(let i=0;i<250;i++) {
        await f.store.put('definitions',{...baseRecord(G,randomUUID()),name:'Definition '+i,content:definition},0);
        await f.store.put('rules',rule(f.ref,{type:'any_image',referenceId:null,name:'Rule '+i,enabled:false,automatic:false}),0);
        if(i<249)await f.store.put('images',{...f.ref,...baseRecord(G,randomUUID()),name:'Reference '+i},0);
        if(i<100)await f.store.put('groups',{...baseRecord(G,randomUUID()),name:'Group '+i},0);
    }
    const s=await f.store.getSettings(G),ids=(offset:number)=>Array.from({length:250},(_,i)=>String(200000000000000000n+BigInt(offset+i)));
    await f.store.putSettings(G,{...s.value,channels:ids(0),excludedChannels:ids(250),exemptRoles:ids(500)},s.revision);
    const p=await exportPack(f.services,G,{complete:true});assert.equal(p.components.length,850);assert.equal(p.policy!.bindings.length,750);await validatePack(p);
});
test('portable identifiers cannot inherit a conflict choice from Object.prototype',async t=>{
    const f=await fixture(t),p=await starterPack(process.cwd(),'custom-template');p.components=p.components.filter(c=>c.kind==='definitions');p.components[0]!.id='constructor';
    await imported(f,p);const d=(await f.store.all<any>('definitions',G))[0]!;
    await f.store.put('definitions',{...d,name:'Local edit',revision:2},1);
    const packs=new Packs(f.services),preview=await packs.preview(G,ADMIN,p,{choices:{}});
    assert.equal(preview.components[0]!.choice,'keep');await packs.apply(G,ADMIN,p,{choices:{}},preview.token);
    assert.equal((await f.store.get<any>('definitions',G,d.id))!.name,'Local edit');
});
test('standalone definition round trip creates no rule; complete policy carries versioned native text definitions',async t=>{
    const f=await fixture(t),p=await starterPack(process.cwd(),'image-scam-analysis');p.components=p.components.filter(c=>c.kind==='definitions');
    await imported(f,p);assert.equal((await f.store.all('rules',G)).length,0);
    const definition=(await f.store.all('definitions',G))[0]!;
    const exported=await exportPack(f.services,G,{components:[{kind:'definitions',id:definition.id}]});assert.equal(exported.components.length,1);assert.equal(exported.assets.length,0);assert.ok(exported.provenance.source.includes(p.id));assert.ok(exported.evidence.length);
    await f.store.put('rules',rule(f.ref,{type:'text',referenceId:null,text:TEXT_STARTERS[0]!.definition,enabled:false,automatic:false}),0);
    const complete=await exportPack(f.services,G,{complete:true});await imported(f,complete);
    const textRules=(await f.store.all<Rule>('rules',G)).filter(r=>r.type==='text');assert.equal(textRules.length,2);assert.deepEqual(textRules[0]!.text,textRules[1]!.text);
});
async function imported(f: Awaited<ReturnType<typeof fixture>>, pack: Pack, options: ImportOptions = {}) {
    const packs = new Packs(f.services), preview = await packs.preview(G, ADMIN, pack, options);
    return packs.apply(G, ADMIN, pack, options, preview.token);
}
test('individual reference round trip preserves exact asset bytes and excludes operational/private records', async (t) => {
    const f = await fixture(t), p = await exportPack(f.services, G, { components: [{ kind: 'images', id: f.ref.id }] });
    assert.equal(p.components.length, 1);
    assert.equal(p.assets.length, 1);
    const serialized = JSON.stringify(p);
    for (const secret of [API_KEY, f.ref.objectKey, ADMIN, G, 'encrypted', 'calibrations', 'jobs', 'approval'])
        assert.ok(!serialized.includes(secret), secret);
    const result = await imported(f, p);
    assert.equal(result.added, 0); // identical existing references are adopted, not duplicated
    const validated = await validatePack(p);
    assert.deepEqual(validated.images.values().next().value!.bytes, f.image.bytes);
    assert.equal(f.control.calls, 0);
});
test('group and individual rules export required dependencies and policy floors', async (t) => {
    const f = await fixture(t), group = { ...baseRecord(G, randomUUID()), name: 'Scams' };
    await f.store.put('groups', group, 0);
    await f.store.put('images', { ...f.ref, groupId: group.id, revision: 2 }, 1);
    const r = rule(f.ref, { type: 'group', groupId: group.id, referenceId: null });
    await f.store.put('rules', r, 0);
    const p = await exportPack(f.services, G, { components: [{ kind: 'rules', id: r.id }] });
    assert.equal(p.components.length, 3);
    assert.equal(p.components.find(c => c.kind === 'rules')!.dependencies.length, 2);
    assert.deepEqual(p.policy!.settings.thresholds, (await f.store.getSettings(G)).value.thresholds);
    const preview=await new Packs(f.services).preview(G,ADMIN,p);
    assert.match(preview.components.find(c=>c.kind==='rules')!.status,/another destination group/);
    const dest=await fixture(t);await dest.store.remove('images',G,dest.ref.id,1);
    const result = await imported(dest, p);
    assert.equal(result.added, 3);
    const destination = (await dest.store.all<Rule>('rules', G))[0]!;
    assert.ok(await dest.store.get('groups', G, destination.groupId!));
    assert.equal((await dest.store.all<ReferenceImage>('images',G))[0]!.groupId,destination.groupId);
    assert.equal(destination.automatic, false);
    assert.equal(destination.enabled, false);
    assert.equal(destination.approval, null);
    assert.equal(destination.action, r.action);
});
test('complete policy includes standalone prompts, rules and mapped grants without secrets', async (t) => {
    const f = await fixture(t), s = await f.store.getSettings(G);
    await f.store.putSettings(G, { ...s.value, channels: [CHANNEL], excludedChannels: [CHANNEL], exemptRoles: [ROLE], logChannel: CHANNEL, enforcement: true, highImpactEnabled: true }, s.revision);
    await f.store.put('grants', { ...baseRecord(G, randomUUID()), roleId: ROLE, capabilities: ['rules.view'] }, 0);
    await f.store.put('rules', rule(f.ref), 0);
    const template = await starterPack(process.cwd(), 'image-scam-analysis');
    await imported(f, template);
    const pack = await exportPack(f.services, G, { complete: true });
    assert.ok(pack.components.some(c => c.kind === 'definitions'));
    assert.ok(!JSON.stringify(pack).includes(CHANNEL));
    assert.ok(!JSON.stringify(pack).includes(ROLE));
    f.discord.members.set(BOT, { guildId: G, userId: BOT, owner: false, administrator: false, roles: [] });
    const mappings = Object.fromEntries(pack.policy!.bindings.map(b => [b.id, b.kind === 'role' ? ROLE : CHANNEL]));
    const packs = new Packs(f.services);
    await assert.rejects(packs.preview(G, ADMIN, pack, { policy: true }), /mapping_required/);
    await imported(f, pack, { policy: true, mappings });
    const settings = (await f.store.getSettings(G)).value;
    assert.deepEqual(settings.channels, [CHANNEL]);
    assert.equal(settings.enforcement, false);
    assert.equal(settings.highImpactEnabled, false);
    assert.deepEqual(settings.exemptRoles, [ROLE]);
    assert.equal(settings.logChannel, CHANNEL);
});
test('repeat import, version upgrade, local edits and unrelated configuration are preserved by default', async (t) => {
    const f = await fixture(t), pack = await starterPack(process.cwd(), 'image-scam-analysis');
    const first = await imported(f, pack);
    assert.equal(first.added, 2);
    assert.equal((await imported(f, pack)).added, 0);
    const r = (await f.store.all<Rule>('rules', G))[0]!;
    await f.store.put('rules', { ...r, name: 'Local policy', revision: 2 }, 1);
    pack.version = '2.0.0';
    pack.components.find(c => c.kind === 'rules')!.value.threshold = .99;
    const packs = new Packs(f.services), preview = await packs.preview(G, ADMIN, pack);
    assert.equal(preview.components.find(c => c.kind === 'rules')!.status, 'locally edited');
    await packs.apply(G, ADMIN, pack, {}, preview.token);
    assert.equal((await f.store.get<Rule>('rules', G, r.id))!.name, 'Local policy');
    const replaced = await imported(f, pack, { choices: { 'analysis-rule': 'replace' } });
    assert.equal(replaced.replaced, 1);
    assert.equal((await f.store.get<Rule>('rules', G, r.id))!.threshold, .99);
    assert.deepEqual(await f.store.get('images', G, f.ref.id), f.ref);
    assert.ok(await f.services.credential(G));
});
test('deleted components remain deleted until explicitly restored', async (t) => {
    const f = await fixture(t), p = await starterPack(process.cwd(), 'image-scam-analysis');
    await imported(f, p);
    const r = (await f.store.all<Rule>('rules', G))[0]!;
    await f.store.remove('rules', G, r.id, r.revision);
    await imported(f, p);
    assert.equal((await f.store.all('rules', G)).length, 0);
    await imported(f, p, { restoreDeleted: true });
    assert.equal((await f.store.all('rules', G)).length, 1);
});
test('preview binds guild, actor, full input, choices and concurrent edits', async (t) => {
    const f = await fixture(t), p = await starterPack(process.cwd(), 'custom-template'), packs = new Packs(f.services);
    const preview = await packs.preview(G, ADMIN, p);
    await assert.rejects(packs.apply(G, ADMIN, p, { restoreDeleted: true }, preview.token), /preview_stale/);
    const altered = structuredClone(p);
    altered.description = 'Different';
    await assert.rejects(packs.apply(G, ADMIN, altered, {}, preview.token), /preview_stale/);
    const s = await f.store.getSettings(G);
    await f.store.putSettings(G, { ...s.value, processBots: true }, s.revision);
    await assert.rejects(packs.apply(G, ADMIN, p, {}, preview.token), /preview_stale/);
    await assert.rejects(packs.preview(G, MOD, p), /administrator_required/);
    await assert.rejects(packs.preview(G2, ADMIN, p), /not_a_guild_member/);
});
test('mapping rechecks destination membership and channel permission at apply', async (t) => {
    const f = await fixture(t), p = await exportPack(f.services, G, { complete: true }), packs = new Packs(f.services);
    p.policy!.bindings = [{ id: 'channel-one', kind: 'channel', purpose: 'channels' }];
    p.policy!.settings.channels = ['channel-one'];
    const opts = { policy: true, mappings: { 'channel-one': CHANNEL } };
    f.discord.members.set(BOT, { guildId: G, userId: BOT, owner: false, administrator: false, roles: [] });
    const preview = await packs.preview(G, ADMIN, p, opts);
    f.discord.allow = false;
    await assert.rejects(packs.apply(G, ADMIN, p, opts, preview.token), /permission_required/);
    f.discord.allow = true;
    await assert.rejects(packs.preview(G, ADMIN, p, { policy: true, mappings: { 'channel-one': '999999' } }), /mapping_required/);
});
test('software and human evidence are untrusted and digest changes visibly stale them', async (t) => {
    const f = await fixture(t), p = await starterPack(process.cwd(), 'image-scam-analysis'), packs = new Packs(f.services);
    assert.equal(p.evidence[0]!.digest, packDigest(p));
    assert.match((await packs.preview(G, ADMIN, p)).evidence[0]!.status, /untrusted/);
    p.components[0]!.value.content.positive = 'Changed policy';
    assert.match((await packs.preview(G, ADMIN, p)).evidence[0]!.status, /stale/);
});
test('transaction failure rolls back policy, components, receipts and audit; orphan recovery keeps shared objects', async (t) => {
    const f = await fixture(t), p = await exportPack(f.services, G, { complete: true }), packs = new Packs(f.services);
    // Force a new reference object, then fail the final audit write.
    const starter = await starterPack(process.cwd(), 'combined-scam-setup');
    starter.components = starter.components.filter(c => c.kind !== 'images' || c === starter.components.find(x => x.kind === 'images'));
    starter.components = starter.components.filter(c => c.kind !== 'rules' || c.value.type !== 'group');
    starter.assets = starter.assets.slice(0, 1);
    const preview = await packs.preview(G, ADMIN, starter), before = await f.store.all('images', G), original = f.services.audit.bind(f.services);
    f.services.audit = async (...args) => { if (args[2] === 'pack.imported')
        throw Error('injected_transaction_failure'); return original(...args); };
    await assert.rejects(packs.apply(G, ADMIN, starter, {}, preview.token), /injected_transaction_failure/);
    assert.deepEqual(await f.store.all('images', G), before);
    assert.equal((await f.store.all('packs', G)).length, 0);
    assert.equal((await f.store.all('definitions', G)).length, 0);
    const dir = join(f.objects.root, G);
    for (const file of await readdir(dir))
        if (file !== f.ref.objectKey.split('/')[1])
            await utimes(join(dir, file), new Date(0), new Date(0));
    await f.objects.collect(G, new Set(before.map(r => (r as ReferenceImage).objectKey)));
    assert.deepEqual(await readdir(dir), [f.ref.objectKey.split('/')[1]]);
    assert.ok(p.assets.length);
});
test('object-write failure does not commit partial import', async (t) => {
    const f = await fixture(t), p = await starterPack(process.cwd(), 'reviewed-scam-references'), packs = new Packs(f.services), preview = await packs.preview(G, ADMIN, p);
    f.objects.put = async () => { throw Error('disk_full'); };
    await assert.rejects(packs.apply(G, ADMIN, p, {}, preview.token), /disk_full/);
    assert.equal((await f.store.all('groups', G)).length, 0);
    assert.equal((await f.store.all('images', G)).length, 1);
});
test('first-login seeding and both reference starters share assets and preserve deletion tombstones', async (t) => {
    const f = await fixture(t);
    await seedStarterReferences(f.services, G2, process.cwd());
    f.discord.members.set(ADMIN, { guildId: G2, userId: ADMIN, owner: false, administrator: true, roles: [] });
    const packs = new Packs(f.services), p = await starterPack(process.cwd(), 'reviewed-scam-references'), images = await f.store.all<ReferenceImage>('images', G2);
    await f.store.remove('images', G2, images[0]!.id, 1);
    for (const id of ['reviewed-scam-references', 'combined-scam-setup']) {
        const pack = id === p.id ? p : await starterPack(process.cwd(), id);
        const preview = await packs.preview(G2, ADMIN, pack);
        await packs.apply(G2, ADMIN, pack, {}, preview.token);
    }
    assert.equal((await f.store.all('images', G2)).length, 32);
    assert.equal((await f.store.all('groups', G2)).length, 1);
});
for (const [name, change, pattern] of [
    ['version', (p: Pack) => { (p as any).format = 'unknown'; }, /unsupported_pack_version/],
    ['traversal', (p: Pack) => { p.components[0]!.id = '../escape'; }, /invalid_component/],
    ['duplicate ids', (p: Pack) => { p.components.push(p.components[0]!); }, /invalid_component/],
    ['dangling dependency', (p: Pack) => { p.components[0]!.dependencies = ['missing']; }, /dangling_dependency/],
    ['private field', (p: Pack) => { (p as any).credentials = { token: 'secret' }; }, /unknown_field/],
    ['source approval', (p: Pack) => { p.components[1]!.value.approval = { actor: 'source' }; }, /unknown_field/],
    ['asset count', (p: Pack) => { p.assets = Array(PACK_LIMITS.assets + 1).fill({}); }, /pack_count_limit/],
    ['component count', (p: Pack) => { p.components = Array(PACK_LIMITS.components + 1).fill(p.components[0]); }, /pack_count_limit/],
    ['unsupported schema', (p: Pack) => { p.compatibility.schema = '999'; }, /incompatible_pack/]
] as const)
    test('reject malicious or incompatible pack: ' + name, async () => { const p = await starterPack(process.cwd(), 'image-scam-analysis'); change(p); await assert.rejects(validatePack(p), pattern); });
test('checksum, corrupt image, image pixel budget, parse depth and expanded limits reject before writing', async () => {
    const p = await starterPack(process.cwd(), 'image-scam-analysis');
    p.assets = [{ id: 'bad', sha256: '0'.repeat(64), base64: 'YWJj' }];
    await assert.rejects(validatePack(p), /checksum/);
    const { createHash } = await import('node:crypto');
    p.assets[0]!.sha256 = createHash('sha256').update('abc').digest('hex');
    await assert.rejects(validatePack(p), /invalid_image/);
    const sharp = (await import('sharp')).default, bytes = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
    p.assets = [{ id: 'large', sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }];
    await assert.rejects(validatePack(p), /invalid_image|pixel_limit/);
    let nested: any = {};
    for (let i = 0; i < 40; i++)
        nested = { nested };
    await assert.rejects(validatePack(nested), /structure_limit/);
});
test('decoded byte and structural-work limits reject small-dimension padded files and oversized input graphs', async () => {
    const { createHash } = await import('node:crypto'), p = await starterPack(process.cwd(), 'custom-template');
    const bytes = Buffer.alloc(7 * 1024 * 1024);
    PNG.copy(bytes);
    p.assets = Array.from({ length: 5 }, (_, i) => ({ id: 'padded-' + i, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }));
    await assert.rejects(validatePack(p), /pack_expanded_limit/);
    const many = { items: Array(100001).fill(null) };
    await assert.rejects(validatePack(many), /pack_structure_limit/);
    const tooLarge = { description: 'x'.repeat(PACK_LIMITS.bytes) };
    await assert.rejects(validatePack(tooLarge), /pack_byte_limit/);
});
test('rule replacement removes fields from a former rule modality and invalidates source approval', async (t) => {
    const f = await fixture(t), p = await starterPack(process.cwd(), 'image-scam-analysis');
    await imported(f, p);
    const c = p.components.find(c => c.kind === 'rules')!;
    delete c.value.content;
    c.value.type = 'any_image';
    await imported(f, p, { choices: { [c.id]: 'replace' } });
    const r = (await f.store.all<Rule>('rules', G))[0]!;
    assert.equal(r.content, undefined);
    assert.equal(r.type, 'any_image');
    assert.equal(r.approval, null);
    assert.equal(r.automatic, false);
});
