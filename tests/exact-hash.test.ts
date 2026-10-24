import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fixture, rule, enable, G, G2, message, USER } from './helpers.js';
import { normalize } from '../server/images.js';
import { fingerprint, resolvePolicy } from '../server/policy.js';
import { Worker } from '../server/worker.js';
import { EvaluationFailure } from '../server/services.js';
import type { Evaluation, ModerationEvent } from '../shared/domain.js';

async function versioned(t: Parameters<typeof fixture>[0]) {
    const f = await fixture(t);
    f.ref = { ...f.ref, hashVersion: f.image.hashVersion, revision: 2 };
    await f.store.put('images', f.ref, 1);
    return f;
}
test('exact normalized content bypasses credentials, quota, provider and tokens with explicit evidence', async t => {
    const f = await versioned(t), r = rule(f.ref), s = (await f.store.getSettings(G)).value;
    f.control.fail = true;
    for (const c of await f.store.all('credentials', G)) await f.store.remove('credentials', G, c.id, c.revision);
    s.dailyCallLimit = 0;
    const result = await f.services.evaluate(G, 'a', f.image, [r], [f.ref], s);
    assert.equal(result.hashComparisons, 1); assert.equal(result.inputTokens, 0); assert.equal(f.control.calls, 0);
    assert.deepEqual(await f.store.usage(G), {day: new Date().toISOString().slice(0,10), calls: 0, inputTokens: 0});
    assert.equal(result.matches[0]!.provenance, 'exact_hash'); assert.equal(result.matches[0]!.probability, null);
    assert.equal(result.matches[0]!.model, null); assert.equal(result.matches[0]!.verified, false);
    assert.ok(!JSON.stringify(result).includes(f.image.sha256));
});
for (const variant of ['missing', 'incompatible', 'different'] as const) test(`${variant} reference digest falls through to Jev`, async t => {
    const f = await versioned(t), r = rule(f.ref), s = (await f.store.getSettings(G)).value;
    const ref = {...f.ref, hashVersion: variant === 'missing' ? undefined : variant === 'incompatible' ? 'other-v1' : f.ref.hashVersion, sha256: variant === 'different' ? 'a'.repeat(64) : f.ref.sha256};
    const result = await f.services.evaluate(G, 'a', f.image, [r], [ref], s);
    assert.equal(result.hashComparisons, 0); assert.equal(f.control.calls, 1); assert.equal(result.matches[0]!.provenance, 'jev');
});
test('normalization strips PNG metadata/encoding variations; crops and recompression need not match', async () => {
    const pixels = Buffer.from(Array.from({length:64*64*3}, (_,i) => (i * 37 + Math.floor(i/192)*19) % 256));
    const original = await sharp(pixels,{raw:{width:64,height:64,channels:3}}).png().toBuffer();
    const encoded = await sharp(original).png({compressionLevel: 0}).toBuffer();
    const metadata = await sharp(original).withExif({IFD0: {Artist: 'Synthetic test'}}).png().toBuffer();
    const n = await normalize(original);
    for (const bytes of [encoded, metadata]) { assert.notDeepEqual(bytes, original); assert.equal((await normalize(bytes)).sha256, n.sha256); }
    const crop = await sharp(original).extract({left:8,top:8,width:48,height:48}).png().toBuffer();
    const compressed = await sharp(original).jpeg({quality:30}).toBuffer();
    const watermarked = await sharp(original).composite([{input:await sharp({create:{width:20,height:8,channels:3,background:'white'}}).png().toBuffer(),left:5,top:5}]).png().toBuffer();
    for (const bytes of [crop,compressed,watermarked]) assert.notEqual((await normalize(bytes)).sha256, n.sha256);
});
test('guild, disabled and reference eligibility gates run before hash matching', async t => {
    const f = await versioned(t), r = rule(f.ref), s = (await f.store.getSettings(G)).value;
    for (const [rules, refs] of [[[r], [{...f.ref, guildId: G2}]], [[{...r, enabled:false}], [f.ref]], [[r], [{...f.ref, enabled:false}]], [[{...r, referenceId:'absent'}], [f.ref]]] as const) {
        assert.equal((await f.services.evaluate(G, 'a', f.image, [...rules], [...refs], s)).matches.length, 0);
    }
    assert.equal(f.control.calls, 0);
});
test('mixed hash/Jev evaluation preserves all rules, references, reuse and priority', async t => {
    const f = await versioned(t), r = rule(f.ref, {type:'any_match', referenceId:null}), higher = rule(f.ref,{priority:10}), s = await enable(f,r);
    const other = {...f.ref,id:'other', hashVersion:undefined};
    const result = await f.services.evaluate(G,'a',f.image,[r,higher],[f.ref,other],s);
    assert.equal(result.matches.length,3); assert.equal(result.hashComparisons,2); assert.equal(f.control.calls,1);
    assert.equal(resolvePolicy([r,higher],result.matches,s,[f.ref,other])!.rule.id,higher.id);
    await f.services.evaluate(G,'a',f.image,[r,r],[other],s);
    assert.equal(f.control.calls,2); // per-evaluation reuse, never persistent
});
test('evidence and approval become stale after reference or matching configuration changes', async t => {
    const f=await versioned(t), r=rule(f.ref), s=await enable(f,r);
    const result=await f.services.evaluate(G,'a',f.image,[r],[f.ref],s);
    assert.equal(resolvePolicy([r],result.matches,s,[f.ref])!.execute,true);
    for (const ref of [{...f.ref,revision:3},{...f.ref,sha256:'b'.repeat(64)},{...f.ref,hashVersion:'other'},{...f.ref,enabled:false}]) assert.equal(resolvePolicy([r],result.matches,s,[ref]),null);
    assert.equal(resolvePolicy([r],result.matches,{...s,model:'jev-9.0.0'},[f.ref]),null);
    assert.notEqual(fingerprint(r,[f.ref],s),fingerprint(r,[f.ref],{...s,thresholds:{...s.thresholds,review:0.9}}));
});
for (const action of ['ban','kick','timeout'] as const) test(`hash ${action} requiring verification goes to review without a verification call`,async t=>{
    const f=await versioned(t),r=rule(f.ref,{action,secondVerification:true}),s=await enable(f,r);
    const result=await f.services.evaluate(G,'a',f.image,[r],[f.ref],s);
    const d=resolvePolicy([r],result.matches,s,[f.ref])!;
    assert.equal(d.action,'review'); assert.equal(d.execute,false); assert.equal(d.reason,'exact_hash:verification_required');assert.equal(f.control.calls,0);
});
test('hash worker review preserves evidence and zero usage, respects acceptance and protected members',async t=>{
    const f=await versioned(t),r=rule(f.ref,{action:'ban'});await enable(f,r);
    const m=message();f.discord.messages.set(m.messageId,m);
    await new Worker(f.services,async()=>f.image).process(m);
    const e=(await f.store.all<ModerationEvent>('events',G))[0]!;
    assert.equal(e.reviewStatus,'open');assert.equal(e.reason,'exact_hash:verification_required');assert.equal(f.discord.performed.length,0);
    const ev=(await f.store.all<Evaluation>('evaluations',G))[0]!;assert.equal(ev.model,null);assert.equal(ev.hashComparisons,1);
    const m2=message(2);f.discord.messages.set(m2.messageId,m2);f.discord.members.get(USER)!.administrator=true;
    await new Worker(f.services,async()=>{throw Error('must not download');}).process(m2);
    assert.equal(f.control.calls,0);
});
test('hash evidence cannot bypass approval, permission or deployment acceptance',async t=>{
    const f=await versioned(t),r=rule(f.ref),s=await enable(f,r);
    const result=await f.services.evaluate(G,'a',f.image,[r],[f.ref],s);
    assert.equal(resolvePolicy([{...r,approval:null}],result.matches,s,[f.ref])!.reason,'exact_hash:calibration_approval_required');
    f.discord.allow=false;
    const m=message();f.discord.messages.set(m.messageId,m);await new Worker(f.services,async()=>f.image).process(m);
    assert.equal((await f.store.all<ModerationEvent>('events',G))[0]!.reviewStatus,'open');
    const m2=message(2);f.discord.messages.set(m2.messageId,m2);await new Worker(f.services,async()=>f.image,false).process(m2);
    assert.ok((await f.store.all<ModerationEvent>('events',G)).some(e=>e.reason==='deployment_acceptance_required'&&e.reviewStatus==='open'));
    assert.equal(f.discord.performed.length,0);
});
test('partial provider failure retains exact evidence but suppresses whole-message enforcement',async t=>{
    const f=await versioned(t),r=rule(f.ref,{type:'any_match',referenceId:null});await enable(f,r);
    const other={...f.ref,id:'other',hashVersion:undefined,revision:1};await f.store.put('images',other,0);f.control.fail=true;
    const s=(await f.store.getSettings(G)).value;
    await assert.rejects(f.services.evaluate(G,'a',f.image,[r],[f.ref,other],s),e=>e instanceof EvaluationFailure&&e.hashComparisons===1&&e.matches[0]!.provenance==='exact_hash');
    const m=message();f.discord.messages.set(m.messageId,m);await assert.rejects(new Worker(f.services,async()=>f.image).process(m));
    assert.equal(f.discord.performed.length,0);assert.equal((await f.store.all<Evaluation>('evaluations',G))[0]!.outcome,'error');
});
test('hash calibration is deterministic evidence, never a fabricated Jev calibration sample',async t=>{
    const f=await versioned(t),r=rule(f.ref);await f.store.put('rules',r,0);
    const result=await f.services.testRule(G,USER,r.id,f.image,true);assert.equal(result.predicted,true);assert.equal(result.probability,null);
    await assert.rejects(f.services.approveRule(G,USER,r.id,'Synthetic approval must not bypass calibration'),/more_labeled_examples_required/);
    assert.equal(f.control.calls,0);
});

test('a labeled exact-hash false positive blocks approval instead of disappearing from calibration',async t=>{
    const f=await versioned(t),r=rule(f.ref);await f.store.put('rules',r,0);
    await f.services.testRule(G,USER,r.id,f.image,false);
    await assert.rejects(f.services.approveRule(G,USER,r.id,'Synthetic approval must reject known false positives'),/calibration_failed/);
    assert.equal(f.control.calls,0);
});

test('hash-only comparison creates no cost ledger attempt or priced token entry with PR 3',async t=>{
    const f=await versioned(t),r=rule(f.ref),s=(await f.store.getSettings(G)).value;
    await f.services.evaluate(G,'a',f.image,[r],[f.ref],s);
    assert.equal(f.store.analytics.records.size,0);
    assert.deepEqual((await f.store.analytics.report(G,{start:new Date().toISOString().slice(0,10),end:new Date(Date.now()+86400000).toISOString().slice(0,10),group:'summary',limit:100})).buckets,[]);
    assert.equal(f.control.calls,0);
});

test('identical provider input reuses a comparison across distinct reference revisions',async t=>{
    const f=await fixture(t),r=rule(f.ref,{type:'any_match',referenceId:null}),s=(await f.store.getSettings(G)).value;
    const other={...f.ref,id:'same-content-different-revision',revision:7};
    const result=await f.services.evaluate(G,'a',f.image,[r],[f.ref,other],s);
    assert.equal(f.control.calls,1);assert.equal(result.matches.length,2);
    assert.equal(result.matches[0]!.referenceRevision,1);assert.equal(result.matches[1]!.referenceRevision,7);
});
