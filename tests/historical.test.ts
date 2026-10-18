import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Historical, snowflakeAt } from '../server/historical.js';
import { MemoryDurable } from '../server/durable.js';
import { Throttle, Deferred, retryAt } from '../server/throttle.js';
import { DiscordRest } from '../server/discord.js';
import { JevClient } from '../server/jev.js';
import { Worker } from '../server/worker.js';
import { fixture, rule, message, G, G2, ADMIN, BOT, CHANNEL, MOD, API_KEY, enable } from './helpers.js';
import { historicalCall } from '../server/services.js';
import { NORMALIZATION_HASH_VERSION, downloadAttachment, setAttachmentThrottle } from '../server/images.js';
import { analyticsQuery } from '../shared/analytics.js';
const input={channels:'all',exclusions:[],budgets:{messages:10000,images:10000,requests:100}};
async function setup(t: TestContext, exact=true) {
    const f=await fixture(t);
    f.discord.members.set(BOT,{guildId:G,userId:BOT,owner:false,administrator:false,roles:[]});
    await f.store.put('rules',rule(f.ref,{action:'review'}),0);
    if(exact) {f.ref.hashVersion=NORMALIZATION_HASH_VERSION;f.ref.revision++;await f.store.put('images',f.ref,1);}
    Object.assign(f.discord,{history:async (_g: string,_c: string,before: string)=>[...f.discord.messages.values()].filter(m=>BigInt(m.messageId)<BigInt(before)).sort((a,b)=>BigInt(a.messageId)>BigInt(b.messageId)?-1:1).slice(0,1)});
    const history=new Historical(f.services,async()=>f.image);
    return {...f,history};
}
async function tick(f: Awaited<ReturnType<typeof setup>>) {
    for(const row of f.store.durable.rows.values()) if(row.kind==='scan'&&['running','throttled'].includes(row.data.status)) {row.due=0;row.data.nextAttempt=0;}
    return new Historical(f.services,async()=>f.image).step();
}
async function drain(f: Awaited<ReturnType<typeof setup>>, max=100) {for(let i=0;i<max;i++) if(!await tick(f)) break;}
test('pre-installation scan has finite cutoff, explicit thread gaps, review-only hash evidence and overlap reuse',async t=>{
    const f=await setup(t);const m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);
    assert.equal(scan.channels[0]!.before,snowflakeAt(Date.parse(scan.cutoff)));
    assert.match(scan.threadCoverage,/archived/);
    await drain(f);
    const done=await f.history.get(G,scan.id);
    assert.equal(done.status,'completed_with_gaps');assert.equal(done.counters.images,1);assert.equal(f.control.calls,0);
    assert.equal((await f.store.all('events',G)).length,1);assert.equal(f.discord.performed.length,0);
    const overlap=await f.history.start(G,ADMIN,input);await drain(f);
    assert.equal((await f.history.get(G,overlap.id)).counters.reused,1);assert.equal((await f.store.all('evaluations',G)).length,1);
    await assert.rejects(f.history.get(G2,scan.id),/scan_not_found/);
    await assert.rejects(f.history.start(G,MOD,input),/server_management_required/);
});
test('pause/resume and cancellation preserve pending cursor across new worker instances',async t=>{
    const f=await setup(t),m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);await tick(f);
    const pending=await f.history.get(G,scan.id);assert.equal(pending.pending!.message,m.messageId);
    assert.equal(pending.channels[0]!.before,scan.channels[0]!.before);
    await f.history.control(G,ADMIN,scan.id,'pause');assert.equal(await tick(f),false);
    await f.history.control(G,ADMIN,scan.id,'resume');await tick(f);
    assert.equal((await f.history.get(G,scan.id)).counters.images,1);
    await f.history.control(G,ADMIN,scan.id,'cancel');assert.equal(await tick(f),false);
    assert.equal((await f.history.get(G,scan.id)).status,'cancelled');assert.equal((await f.store.all('evaluations',G)).length,1);
});
test('configuration and requester permission changes pause work before provider dispatch',async t=>{
    const f=await setup(t,false),m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);await tick(f);
    const settings=await f.store.getSettings(G);await f.store.putSettings(G,{...settings.value,processBots:true},settings.revision);
    await tick(f);assert.equal((await f.history.get(G,scan.id)).status,'paused');assert.equal(f.control.calls,0);
    await assert.rejects(f.history.control(G,ADMIN,scan.id,'resume'),/policy_changed/);
    const other=await f.history.start(G,ADMIN,input);f.discord.members.get(ADMIN)!.administrator=false;await tick(f);
    assert.equal((await f.history.get(G,other.id)).status,'paused');assert.equal(f.control.calls,0);
});
test('deleted, edited, unsupported and inaccessible history never reports full completion',async t=>{
    for(const kind of ['deleted','edited','unsupported','permission']) {
        const f=await setup(t),m=message();if(kind==='unsupported') m.attachments[0]!.filename='x.txt',m.attachments[0]!.contentType='text/plain';
        f.discord.messages.set(m.messageId,m);const scan=await f.history.start(G,ADMIN,input);await tick(f);
        if(kind==='deleted')f.discord.messages.clear();if(kind==='edited')m.editedAt=new Date().toISOString();if(kind==='permission')f.discord.allow=false;
        await drain(f);const result=await f.history.get(G,scan.id);
        assert.ok(['completed_with_gaps','failed'].includes(result.status));assert.ok(result.counters.failed>0);assert.ok(result.failures.length>0);assert.equal(f.control.calls,0);
    }
});
test('message, image, request and daily budgets stop before unbounded work',async t=>{
    for(const kind of ['messages','images','requests','daily']) {
        const f=await setup(t,false);for(let n=0;n<3;n++){const m=message(n);f.discord.messages.set(m.messageId,m);}
        if(kind==='daily') {const s=await f.store.getSettings(G);await f.store.putSettings(G,{...s.value,dailyCallLimit:1},s.revision);}
        const scan=await f.history.start(G,ADMIN,{...input,budgets:{...input.budgets,...(kind==='daily'?{}:{[kind]:1})}});await drain(f);
        const result=await f.history.get(G,scan.id);assert.equal(result.status,'budget_paused',kind);assert.ok(f.control.calls<= (kind==='messages'||kind==='images'?1:kind==='requests'||kind==='daily'?1:100));
    }
});
test('large lazy synthetic history keeps one pending message and no historical job queue',async t=>{
    const f=await setup(t);let remaining=2000, requests=0;
    Object.assign(f.discord,{history:async(_g:string,_c:string,before:string)=>{requests++;if(!remaining--)return [];return [{...message(),messageId:(BigInt(before)-1n).toString(),attachments:[]}];}});
    const scan=await f.history.start(G,ADMIN,input);let maxBytes=0;
    for(let i=0;i<6005;i++) {if(!await tick(f))break;maxBytes=Math.max(maxBytes,JSON.stringify(await f.history.get(G,scan.id)).length);}
    assert.equal((await f.history.get(G,scan.id)).counters.messages,2000);assert.equal(requests,2001);assert.ok(maxBytes<5000);assert.equal(await f.store.claim(),null);
});
test('Discord bucket/global Retry-After is durable and major parameters remain independent',async()=>{
    const durable=new MemoryDurable();let calls=0;
    const http=async()=>{calls++;return Response.json({retry_after:3600,global:true},{status:429,headers:{'retry-after':'3600','x-ratelimit-bucket':'shared'}});};
    const rest=new DiscordRest('test-token','id','secret',http as typeof fetch);rest.throttle=new Throttle(durable);
    await assert.rejects(rest.request('/channels/123456/messages'),Deferred);
    const restarted=new DiscordRest('test-token','id','secret',http as typeof fetch);restarted.throttle=new Throttle(durable);
    await assert.rejects(restarted.request('/guilds/654321'),Deferred);assert.equal(calls,1);
    const store=new MemoryDurable();let routes=0;
    const bucket=new DiscordRest('other','id','secret',(async()=>{routes++;return Response.json([], {headers:{'x-ratelimit-bucket':'b','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'3600'}});}) as typeof fetch);bucket.throttle=new Throttle(store);
    await bucket.request('/channels/123456/messages');await assert.rejects(bucket.request('/channels/123456/messages'),Deferred);
    await bucket.request('/channels/654321/messages');assert.equal(routes,2);
    assert.equal(retryAt(new Headers({'retry-after':'Wed, 01 Jan 2031 00:00:00 GMT'}),undefined,0),Date.parse('2031-01-01T00:00:00Z'));
});
test('shared Jev cooldown defers without sleeping or unaccounted extra attempts across clients',async()=>{
    const durable=new MemoryDurable();let calls=0,reservations=0,completions=0;
    const http=async()=>{calls++;return Response.json({usage:{input_tokens:17}},{status:429,headers:{'retry-after':'3600'}});};
    const options={key:API_KEY,model:'model',mode:'exact' as const,onAttempt:async()=>{reservations++;},onComplete:async(_id:string,c:any)=>{completions++;assert.equal(c.inputTokens,17);}};
    const first=new JevClient(http as typeof fetch,async()=>{assert.fail('must not sleep');},new Throttle(durable));
    await assert.rejects(first.compare(Buffer.from('a'),Buffer.from('b'),options),Deferred);
    const second=new JevClient(http as typeof fetch,undefined,new Throttle(durable));
    await assert.rejects(second.compare(Buffer.from('a'),Buffer.from('b'),options),Deferred);
    assert.equal(calls,1);assert.equal(reservations,1);assert.equal(completions,1);
});
test('CDN cooldown is shared with all download callers and survives limiter recreation',async()=>{
    const durable=new MemoryDurable();setAttachmentThrottle(new Throttle(durable));let calls=0;
    const http=(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'3600'}});}) as typeof fetch;
    await assert.rejects(downloadAttachment(message().attachments[0]!,CHANNEL,http),Deferred);
    setAttachmentThrottle(new Throttle(durable));await assert.rejects(downloadAttachment(message().attachments[0]!,CHANNEL,http),Deferred);assert.equal(calls,1);
    setAttachmentThrottle(undefined);
});
test('scan provider attempts are attributable in the existing usage ledger',async t=>{
    const f=await setup(t,false),m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);await drain(f);
    const page=await f.store.analytics.attempts(G,analyticsQuery(new URLSearchParams('correlationId='+scan.id)));
    assert.equal(page.items.length,1);assert.equal(page.items[0]!.inputTokens,100);assert.equal(page.items[0]!.costMicros,null);
});
test('worker prioritizes eight live jobs then gives historical work a turn',async t=>{
    const f=await setup(t);for(let n=0;n<20;n++)await f.store.enqueue(message(n));
    const worker=new Worker(f.services);let live=0;const turns:number[]=[];
    worker.process=async()=>{if(++live===20)worker.stop();};worker.historyStep=async()=>{turns.push(live);return true;};
    await worker.run();assert.deepEqual(turns,[8,16]);
});
test('crash after evidence and receipt but before scan checkpoint reuses evidence exactly once',async t=>{
    const f=await setup(t),m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);await tick(f);
    const change=f.store.durable.change.bind(f.store.durable);let crashed=false;
    f.store.durable.change=async(id,initial,update)=>change(id,initial,row=>{
        if(crashed) throw new Error('simulated process death');
        const result=update(row);
        if(id==='scan:'+scan.id&&row.data.pending?.index===1) {crashed=true;throw new Error('simulated process death');}
        return result;
    });
    await assert.rejects(tick(f),/process death/);f.store.durable.change=change;
    assert.equal((await f.history.get(G,scan.id)).pending!.index,0);
    assert.equal((await f.store.all('evaluations',G)).length,1);
    await drain(f);assert.equal((await f.history.get(G,scan.id)).counters.images,1);
    assert.equal((await f.store.all('events',G)).length,1);
});
test('cancellation during provider evaluation keeps usage and evidence but stops new work',async t=>{
    const f=await setup(t,false),m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);await tick(f);
    const compare=f.services.jev.compare.bind(f.services.jev);
    f.services.jev.compare=async(...args)=>{const r=await compare(...args);await f.history.control(G,ADMIN,scan.id,'cancel');return r;};
    await tick(f);const result=await f.history.get(G,scan.id);
    assert.equal(result.status,'cancelled');assert.equal(result.counters.images,1);assert.equal((await f.store.usage(G)).calls,1);
    assert.equal(await tick(f),false);assert.equal(f.discord.performed.length,0);
});
test('Gateway overlap retains live action deduplication and historical work never claims an action',async t=>{
    const f=await setup(t),m=message();f.discord.messages.set(m.messageId,m);
    const liveRule=rule(f.ref,{action:'delete'});await enable(f,liveRule);
    const scan=await f.history.start(G,ADMIN,input);await drain(f);
    assert.equal((await f.store.actions(G)).length,0);
    const worker=new Worker(f.services,async()=>f.image);
    await worker.process(m);await worker.process(m);
    assert.ok(f.discord.performed.length<=1);assert.equal((await f.history.get(G,scan.id)).counters.images,1);
});
test('live, historical, rule-test and validation calls share provider admission and usage',async t=>{
    const f=await setup(t,false);let active=0,max=0,calls=0;
    const client=new JevClient((async()=>{active++;max=Math.max(max,active);calls++;await new Promise(r=>setTimeout(r,5));active--;return Response.json({model:'jev-1.14.0',answers:{match:{type:'noul',noul:0.9}},usage:{input_tokens:13}});}) as typeof fetch,undefined,new Throttle(f.store.durable));
    Object.defineProperty(f.services,'jev',{value:client});
    const operations=['moderation','rule_test','credential_validation'].map(p=>()=>f.services.call(G,f.image.bytes,f.image.bytes,'exact','jev-1.14.0',false,undefined,p as 'moderation'));
    const result=await Promise.allSettled([...operations.map(fn=>fn()),historicalCall.run({scanId:'11111111-1111-4111-8111-111111111111',cache:'historical-test',beforeAttempt:async()=>{}},()=>operations[0]!())]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(max,1);assert.equal((await f.store.usage(G)).calls,1);
});
test('verification quantum accounts partial usage and resumes without repeating successful comparison',async t=>{
    const f=await setup(t,false),m=message();f.discord.messages.set(m.messageId,m);
    const rules=await f.store.all<any>('rules',G);const r=rules[0];await f.store.put('rules',{...r,secondVerification:true,revision:2},1);
    const scan=await f.history.start(G,ADMIN,input);await tick(f);await tick(f);
    assert.equal(f.control.calls,1);assert.equal((await f.history.get(G,scan.id)).status,'throttled');
    await tick(f);assert.equal(f.control.calls,2);assert.equal((await f.history.get(G,scan.id)).counters.images,1);
    assert.equal((await f.store.usage(G)).inputTokens,200);
});
test('scope preview explains exclusions, unavailable selections and inclusive/exclusive dates',async t=>{
    const f=await setup(t);const other='100000000000000022',forum='100000000000000023';
    f.discord.metadata=async()=>({name:'Test',roles:[],channels:[{id:CHANNEL,name:'included',type:0,guild_id:G},{id:other,name:'excluded',type:0,guild_id:G},{id:forum,name:'forum',type:15,guild_id:G}]});
    const from='2020-01-01T00:00:00.000Z',to='2020-01-02T00:00:00.000Z';
    for(const [n,time] of [[1,Date.parse(from)-1],[2,Date.parse(from)],[3,Date.parse(to)]] as const) {const m={...message(n),messageId:snowflakeAt(time)};f.discord.messages.set(m.messageId,m);}
    const scan=await f.history.start(G,ADMIN,{...input,exclusions:[other],from,to});
    assert.equal(scan.channels.find(c=>c.id===other)!.reason,'excluded_channel');assert.equal(scan.channels.find(c=>c.id===forum)!.reason,'unsupported_container');
    await drain(f);assert.equal((await f.history.get(G,scan.id)).counters.messages,1);
    await assert.rejects(f.history.prepare(G,ADMIN,{...input,channels:[],exclusions:[]}),/no_eligible/);
});
test('persistent account budget spans different credentials without further provider dispatch',async t=>{
    const previous=process.env.JEV_DAILY_REQUEST_LIMIT;process.env.JEV_DAILY_REQUEST_LIMIT='1';
    t.after(()=>{if(previous===undefined)delete process.env.JEV_DAILY_REQUEST_LIMIT;else process.env.JEV_DAILY_REQUEST_LIMIT=previous;});
    const durable=new MemoryDurable();let calls=0;
    const client=new JevClient((async()=>{calls++;return Response.json({model:'model',answers:{match:{type:'noul',noul:0.9}},usage:{input_tokens:1}});}) as typeof fetch,undefined,new Throttle(durable));
    const o={key:API_KEY,model:'model',mode:'exact' as const,onAttempt:async()=>{}};
    await client.compare(Buffer.from('a'),Buffer.from('b'),o);
    await assert.rejects(client.compare(Buffer.from('a'),Buffer.from('b'),{...o,key:API_KEY+'other'}),/jev_account_budget_exhausted/);
    assert.equal(calls,1);
});
test('repeated CDN throttles have a finite retry budget and failed images consume their budget',async t=>{
    const f=await setup(t),m=message();f.discord.messages.set(m.messageId,m);
    const scan=await f.history.start(G,ADMIN,input);await tick(f);let calls=0;
    const history=new Historical(f.services,async()=>{calls++;throw new Deferred(Date.now(),'cdn_rate_limit_deferred');});
    for(let n=0;n<10;n++) {const row=f.store.durable.rows.get('scan:'+scan.id)!;if(row.data.status==='completed_with_gaps')break;row.due=0;await history.step();}
    assert.equal(calls,3);const done=await f.history.get(G,scan.id);assert.equal(done.counters.images,1);assert.equal(done.counters.failed,1);assert.equal(done.status,'completed_with_gaps');
});
