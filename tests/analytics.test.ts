import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyticsQuery, estimate, money, parseRate, type Attempt, type Completion } from '../shared/analytics.js';
import { JevClient } from '../server/jev.js';
import { Services } from '../server/services.js';
import { csvCell } from '../server/security.js';
import { fixture, rule, G, G2, ADMIN, PNG } from './helpers.js';
const model='jev-1.14.0';
const rate=()=>parseRate({model,revision:0,currency:'USD',perMillion:'1.234567',effectiveAt:'2020-01-01T00:00:00.000Z',note:'Synthetic test rate, not provider pricing'});
const query=()=>analyticsQuery(new URLSearchParams());
const attempt=(): Attempt=>({id:randomUUID(),correlationId:randomUUID(),guildId:G,model,purpose:'moderation',mode:'exact',verification:false,retry:0,startedAt:new Date().toISOString(),completedAt:null,outcome:'reserved',error:null,inputTokens:null,rate:null,costMicros:null});

test('exact price arithmetic rounds half up per attempt and preserves large integer sums',()=>{
    assert.equal(estimate(1,{...rate(),perMillion:'0.5'}),'1');
    assert.equal(estimate(1,{...rate(),perMillion:'0.499999'}),'0');
    assert.equal(estimate(1000000,rate()),'1234567');
    assert.equal(estimate(null,rate()),null); assert.equal(estimate(100,null),null);
    assert.equal(money('9007199254740993000001'),'9007199254740993.000001');
    for(const perMillion of ['-1','1e6','NaN','1.1234567']) assert.throws(()=>parseRate({...rate(),perMillion}));
});
test('UTC month, midnight, leap-day, range and cursor validation',()=>{
    const now=new Date('2026-03-01T00:00:00.000Z');
    assert.throws(()=>analyticsQuery(new URLSearchParams('before=2026-03-01T00:00:00.000Z&beforeId=------------------------------------'),now));
    assert.deepEqual([analyticsQuery(new URLSearchParams('range=mtd'),now).start,analyticsQuery(new URLSearchParams('range=7d'),now).start],['2026-03-01','2026-02-23']);
    for(const q of ['range=custom&start=2026-02-30&end=2026-03-01','range=custom&start=2025-01-01&end=2026-03-01','range=no','limit=0','limit=101','limit=1.5','group=evil','purpose=evil','verification=1','outcome=evil','before=x','limit=1&limit=2','unknown=1']) assert.throws(()=>analyticsQuery(new URLSearchParams(q),now),q);
});
test('idempotent concurrent reservation/finalization and tenant isolation',async t=>{
    const f=await fixture(t),a=attempt(); await f.store.analytics.putRate(G,rate());
    await Promise.all(Array.from({length:8},()=>f.store.analytics.reserve(a,5)));
    await f.store.analytics.dispatch(G,a.id);
    const c: Completion={outcome:'success',error:null,inputTokens:123,completedAt:new Date().toISOString()};
    await Promise.all(Array.from({length:8},()=>f.store.analytics.finalize(G,a.id,c)));
    assert.equal((await f.store.usage(G)).calls,1);assert.equal((await f.store.usage(G)).inputTokens,123);
    assert.equal((await f.store.analytics.report(G,query())).buckets[0]!.costMicros,'152');
    assert.equal((await f.store.analytics.attempts(G2,query())).items.length,0);
    await assert.rejects(f.store.analytics.finalize(G2,a.id,c));
});
test('effective rates snapshot independently and mixed currencies stay separate',async t=>{
    const f=await fixture(t); await f.store.analytics.putRate(G,rate()); const a=attempt();await f.store.analytics.reserve(a,10);
    await f.store.analytics.putRate(G,{...rate(),revision:1,currency:'EUR',perMillion:'2'});
    const b=attempt();await f.store.analytics.reserve(b,10);
    for(const v of [a,b]) {await f.store.analytics.dispatch(G,v.id);await f.store.analytics.finalize(G,v.id,{outcome:'success',inputTokens:1000000,error:null,completedAt:new Date().toISOString()});}
    const rows=(await f.store.analytics.report(G,query())).buckets;
    assert.deepEqual(rows.map(b=>[b.currency,b.costMicros]),[['USD','1234567'],['EUR','2000000']]);
    await f.store.analytics.putRate(G,{...rate(),revision:2,currency:'GBP',effectiveAt:'2099-01-01T00:00:00.000Z'});
    const c=attempt();await f.store.analytics.reserve(c,10);assert.equal(f.store.analytics.records.get(G+':'+c.id)!.rate!.currency,'EUR');
    await assert.rejects(f.store.analytics.putRate(G,rate()),/revision_conflict/);
});
test('credential validation and cached second verification have separate attempt semantics',async t=>{
    const f=await fixture(t);await f.services.testCredential(G);
    const rules=[rule(f.ref,{secondVerification:true}),rule(f.ref,{secondVerification:true})];
    await f.services.evaluate(G,'unused',f.image,rules,[f.ref],(await f.store.getSettings(G)).value);
    const rows=(await f.store.analytics.attempts(G,query())).items;
    assert.equal(rows.length,3);assert.equal(rows.filter(a=>a.verification).length,1);
    assert.equal(rows.filter(a=>a.purpose==='credential_validation').length,1);
    assert.equal(new Set(rows.filter(a=>a.purpose==='moderation').map(a=>a.correlationId)).size,1);
    const r=rule(f.ref);await f.store.put('rules',r,0);await f.services.testRule(G,ADMIN,r.id,f.image,true);
    assert.equal((await f.store.analytics.attempts(G,query())).items.filter(a=>a.purpose==='rule_test').length,1);
});
test('valid usage survives invalid moderation answer and missing usage remains unknown',async t=>{
    const f=await fixture(t);
    for(const usage of [{input_tokens:321},undefined]) {
        const s=new Services(f.store,f.objects,f.vault,new JevClient(async()=>Response.json({model,answers:{match:{type:'text',noul:'bad'}},usage})),f.discord);
        await assert.rejects(s.call(G,PNG,PNG,'exact',model));
    }
    const b=(await f.store.analytics.report(G,query())).buckets[0]!;
    assert.equal(b.inputTokens,'321');assert.equal(b.unknownUsage,1);assert.equal(b.failures,2);assert.equal(b.covered,0);
});
test('network uncertainty and retry responses account each attempt including HTTP usage',async t=>{
    const f=await fixture(t);let calls=0;
    const s=new Services(f.store,f.objects,f.vault,new JevClient(async()=>{calls++;if(calls===1)throw new Error('network');if(calls===2)return Response.json({usage:{input_tokens:7}},{status:503});return Response.json({model,answers:{match:{type:'noul',noul:1}},usage:{input_tokens:11}});},async()=>{}),f.discord);
    await s.call(G,PNG,PNG,'exact',model);
    const b=(await f.store.analytics.report(G,query())).buckets[0]!;
    assert.equal(b.attempts,3);assert.equal(b.uncertain,1);assert.equal(b.failures,1);assert.equal(b.successes,1);assert.equal(b.inputTokens,'18');
    assert.deepEqual((await f.store.analytics.attempts(G,query())).items.map(a=>a.retry).sort(),[0,1,2]);
});
test('successful earlier comparison remains accounted when later verification fails',async t=>{
    const f=await fixture(t);let calls=0;
    const s=new Services(f.store,f.objects,f.vault,new JevClient(async()=>++calls===1?Response.json({model,answers:{match:{type:'noul',noul:1}},usage:{input_tokens:50}}):new Response('{}',{status:401})),f.discord);
    await assert.rejects(s.evaluate(G,'unused',f.image,[rule(f.ref,{secondVerification:true})],[f.ref],(await f.store.getSettings(G)).value));
    assert.equal((await f.store.usage(G)).inputTokens,50);assert.equal((await f.store.analytics.report(G,query())).buckets[0]!.attempts,2);
});
test('accounting failure never retries provider or invalidates credential',async t=>{
    const f=await fixture(t),before=await f.services.credential(G);let writes=0;
    f.store.analytics.finalize=async()=>{writes++;throw new Error('database unavailable');};
    await assert.rejects(f.services.call(G,PNG,PNG,'exact',model),/usage_accounting_unavailable/);
    assert.equal(f.control.calls,1);assert.equal(writes,3);assert.deepEqual(await f.services.credential(G),before);
    assert.equal((await f.store.analytics.report(G,query())).buckets[0]!.pending,1);
});
test('ambiguous successful database commit can be retried without duplicate tokens',async t=>{
    const f=await fixture(t),finish=f.store.analytics.finalize.bind(f.store.analytics);let writes=0;
    f.store.analytics.finalize=async(...args)=>{await finish(...args);if(++writes===1)throw new Error('lost commit acknowledgement');};
    await f.services.call(G,PNG,PNG,'exact',model);assert.equal(f.control.calls,1);assert.equal((await f.store.usage(G)).inputTokens,100);
});
test('tuple cursor retains equal timestamp rows and CSV neutralizes formula prefixes',async t=>{
    const f=await fixture(t),a=attempt();for(let i=0;i<4;i++)await f.store.analytics.reserve({...a,id:randomUUID()},10);
    const q={...query(),limit:2},one=await f.store.analytics.attempts(G,q),two=await f.store.analytics.attempts(G,{...q,...one.next!});
    assert.equal(new Set([...one.items,...two.items].map(a=>a.id)).size,4);assert.equal(two.next,null);
    assert.equal(csvCell(' =HYPERLINK("evil")'),'"\' =HYPERLINK(""evil"")"');
});

test('interrupted response body remains uncertain, and reservation failure never sends HTTP',async t=>{
    const f=await fixture(t);
    const stream=new ReadableStream({start(c){c.error(new Error('connection dropped'));}});
    const s=new Services(f.store,f.objects,f.vault,new JevClient(async()=>new Response(stream)),f.discord);
    await assert.rejects(s.call(G,PNG,PNG,'exact',model));
    assert.equal((await f.store.analytics.report(G,query())).buckets[0]!.uncertain,1);
    const before=await f.services.credential(G);
    f.store.analytics.reserve=async()=>{throw new Error('database down');};
    await assert.rejects(f.services.call(G,PNG,PNG,'exact',model),/usage_accounting_unavailable/);
    assert.equal(f.control.calls,0);assert.deepEqual(await f.services.credential(G),before);
});
