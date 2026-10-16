// Only run against a newly created disposable local database. Never reads .env.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrateDatabase, assertMigrated } from '../dist/server/database.js';
import { analyticsQuery } from '../dist/shared/analytics.js';
assert.equal(process.env.ALLOW_DATABASE_TESTS,'true');
const url=new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/cost_test');
const {pool,store,kind}=await openDatabase(url.href);
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const query=(sql,values=[])=>{let i=0;return pool.query(kind==='postgres'?sql.replace(/\?/g,()=>`$${++i}`):sql,values);};
const g='639510160001',g2='639510160002',now=new Date().toISOString();
const a=(at=now)=>({id:randomUUID(),guildId:g,correlationId:randomUUID(),model:'jev-1.14.0',purpose:'moderation',mode:'exact',verification:false,retry:0,startedAt:at,completedAt:null,outcome:'reserved',error:null,inputTokens:null,rate:null,costMicros:null});
const rate={model:'jev-1.14.0',revision:0,currency:'USD',perMillion:'1.234567',effectiveAt:'2020-01-01T00:00:00.000Z',note:'Synthetic test only'};
const done={outcome:'success',inputTokens:1000000,error:null,completedAt:now};
try {
 console.log(kind, (await pool.query('SELECT VERSION() AS version')).rows[0].version);
 // Populate the untouched 001 schema first; MySQL simulates interruption midway through 002 DDL.
 const initial=await readFile(kind==='mysql'?'db/mysql/001_initial.sql':'db/001_initial.sql','utf8');
 if(kind==='mysql') for(const sql of initial.split(';').map(s=>s.trim()).filter(Boolean))await pool.query(sql);else await pool.query(initial);
 await store.getSettings(g);await store.getSettings(g2);await store.reserveCall(g,100);await store.addTokens(g,77);
 if(kind==='mysql') { const sql=await readFile('db/mysql/002_usage.sql','utf8');for(const statement of sql.split(';').slice(0,3))await pool.query(statement); }
 await Promise.all([migrateDatabase(pool,kind),migrateDatabase(pool,kind)]);await assertMigrated(pool,kind);
 eq((await query("SELECT version FROM schema_migrations WHERE version='002'")).rowCount,1);
 const q=analyticsQuery(new URLSearchParams());
 let report=await store.analytics.report(g,q);eq(report.legacy,{calls:'1',inputTokens:'77'});eq(report.buckets,[]);
 await store.withGuild(g,tx=>tx.analytics.putRate(g,rate));
 const first=a();await Promise.all(Array.from({length:8},()=>store.analytics.reserve(first,100)));
 await store.analytics.dispatch(g,first.id);await Promise.all(Array.from({length:8},()=>store.analytics.finalize(g,first.id,done)));
 eq((await store.usage(g)).calls,2);eq((await store.usage(g)).inputTokens,1000077);
 report=await store.analytics.report(g,q);eq(report.buckets[0].costMicros,'1234567');eq(report.buckets[0].inputTokens,'1000000');eq(report.legacy.calls,'1');
 await migrateDatabase(pool,kind);eq((await store.analytics.report(g,q)).legacy,{calls:'1',inputTokens:'77'});
 eq((await store.analytics.attempts(g2,q)).items,[]);await assert.rejects(store.analytics.finalize(g2,first.id,done));checks++;
 // Price revisions, effective dates, immutable historical snapshots, mixed currencies.
 await store.withGuild(g,tx=>tx.analytics.putRate(g,{...rate,revision:1,currency:'EUR',perMillion:'2'}));
 const second=a();await store.analytics.reserve(second,100);await store.analytics.dispatch(g,second.id);await store.analytics.finalize(g,second.id,{...done,inputTokens:1});
 await store.withGuild(g,tx=>tx.analytics.putRate(g,{...rate,revision:2,currency:'GBP',effectiveAt:'2099-01-01T00:00:00.000Z'}));
 const third=a();await store.analytics.reserve(third,100);eq((await store.analytics.attempts(g,q)).items.find(v=>v.id===third.id).rate.currency,'EUR');
 const mixed=await store.analytics.report(g,q);eq(mixed.buckets.map(b=>b.currency),['EUR','USD']);eq(mixed.buckets.find(b=>b.currency==='USD').costMicros,'1234567');
 const conflict=await Promise.allSettled([3,3].map(revision=>store.withGuild(g,tx=>tx.analytics.putRate(g,{...rate,revision}))));eq(conflict.filter(r=>r.status==='fulfilled').length,1);
 // Quota concurrency remains atomic, including ledger reservations.
 const reservations=await Promise.allSettled(Array.from({length:12},()=>store.analytics.reserve({...a(),guildId:g2},3)));eq(reservations.filter(r=>r.status==='fulfilled').length,3);eq((await store.usage(g2)).calls,3);
 // Cross-month response credits the original UTC day, even with duplicate completion.
 const month=new Date(now);month.setUTCDate(1);month.setUTCHours(0,0,0,0);const before=new Date(month.getTime()-1).toISOString();
 const crossing=a(before);await store.analytics.reserve(crossing,100);await store.analytics.dispatch(g,crossing.id);await store.analytics.finalize(g,crossing.id,{...done,inputTokens:17});await store.analytics.finalize(g,crossing.id,{...done,inputTokens:17});
 const day=(await query('SELECT input_tokens FROM usage_daily WHERE guild_id=? AND day=?',[g,before.slice(0,10)])).rows[0];eq(Number(day.input_tokens),17);
 // Tuple pagination: no loss for identical milliseconds.
 let cursor={},ids=[];do{const page=await store.analytics.attempts(g,{...q,limit:1,...cursor});ids.push(...page.items.map(a=>a.id));cursor=page.next;}while(cursor);eq(new Set(ids).size,3);
 for(const group of ['day','model','purpose','verification','outcome'])eq((await store.analytics.report(g,{...q,group})).buckets.reduce((s,b)=>s+b.attempts,0),3);
 // Unpriced / unknown states and no invented zero usage.
 const missing={...a(),model:'unpriced-model'};await store.analytics.reserve(missing,100);await store.analytics.dispatch(g,missing.id);await store.analytics.finalize(g,missing.id,{...done,outcome:'uncertain',inputTokens:null,error:'jev_network_error'});
 const unpriced=(await store.analytics.report(g,q)).buckets.find(b=>b.currency===null);eq(unpriced.unknownUsage,1);eq(unpriced.covered,0);eq(unpriced.uncertain,1);
 // Concurrent cleanup deletes only expired rows. Daily totals outlive details.
 const old=a(new Date(Date.now()-101*86400000).toISOString());await store.analytics.reserve(old,100);await store.analytics.dispatch(g,old.id);await store.analytics.finalize(g,old.id,done);
 await Promise.all([store.maintenance(),store.maintenance()]);eq((await query('SELECT id FROM usage_attempts WHERE guild_id=? AND id=?',[g,old.id])).rowCount,0);eq((await query('SELECT calls FROM usage_daily WHERE guild_id=? AND day=?',[g,old.startedAt.slice(0,10)])).rowCount,1);
 eq((await store.analytics.report(g,q)).buckets.reduce((s,b)=>s+b.attempts,0),4);
 console.log(`Cost analytics: ${checks} assertions passed; populated 001 upgrade, repeated/concurrent migration${kind==='mysql'?', interrupted DDL recovery':''}, idempotency, concurrency, tenant isolation, exact money, effective rates, pagination, UTC month boundary, retention.`);
} finally { await pool.end(); }
