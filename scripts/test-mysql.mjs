/** Destructive only to newly generated test guilds. Use a disposable database. */
import nativeAssert from 'node:assert/strict';
let assertions=0;
const assert=new Proxy(nativeAssert,{get(target,key){const value=target[key];return typeof value==='function'?(...args)=>{assertions++;return value(...args);}:value;}});
import { migrateDatabase } from '../dist/server/database.js';
import { randomUUID } from 'node:crypto';
import { MySqlStore,openMySqlPool } from '../dist/server/mysql.js';
import { baseRecord } from '../dist/shared/domain.js';
assert.equal(process.env.ALLOW_DATABASE_TESTS,'true','Set ALLOW_DATABASE_TESTS=true for an isolated, migrated test database.');
assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; DATABASE_URL is deliberately not used.');
const url=new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.protocol,'mysql:');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Only loopback TEST_DATABASE_URL is allowed.');
let pool=await openMySqlPool(process.env.TEST_DATABASE_URL),store=new MySqlStore(pool);
const g=String(Date.now())+'01',g2=String(Date.now())+'02';
try{
  console.log(`MySQL version: ${(await pool.query('SELECT VERSION() AS version')).rows[0].version}`);
  await Promise.all([migrateDatabase(pool,'mysql'),migrateDatabase(pool,'mysql')]);
  assert.equal((await pool.query("SELECT version FROM schema_migrations WHERE version='001'")).rowCount,1);
  const s=await store.getSettings(g);await store.getSettings(g2);assert.equal(s.value.enforcement,false);
  await store.putSettings(g,{...s.value,channels:['123456789']},s.revision);
  await assert.rejects(store.putSettings(g,s.value,s.revision),/revision_conflict/);
  const group={...baseRecord(g,randomUUID()),name:'Database test'};await store.put('groups',group,0);
  assert.equal((await store.get('groups',g,group.id)).name,'Database test');assert.equal(await store.get('groups',g2,group.id),null);
  await assert.rejects(store.put('images',{...baseRecord(g2,randomUUID()),groupId:group.id},0),/reference_in_use_or_wrong_guild/);
  await assert.rejects(store.withGuild(g,async tx=>{await tx.remove('groups',g,group.id,1);throw new Error('rollback_requested');}),/rollback_requested/);
  assert.ok(await store.get('groups',g,group.id));
  const message={guildId:g,channelId:'123456789',messageId:'234567891',userId:'345678912',bot:false,webhook:false,attachments:[{id:'456789123',url:'https://cdn.discordapp.com/attachments/123456789/456789123/test.png',size:100,contentType:'image/png',filename:'test.png'}]};
  assert.equal(await store.enqueue(message),true);assert.equal(await store.enqueue(message),false);
  const job=await store.claim();assert.equal(job.guildId,g);await store.finish(job.id,null);
  await store.markSeen(g,message.messageId,message.attachments[0].id);assert.equal(await store.seen(g,message.messageId,message.attachments[0].id),true);
  const action={guildId:g,messageId:message.messageId,slot:'user',action:'timeout',status:'attempting',detail:'',createdAt:new Date().toISOString()};
  assert.equal(await store.beginAction(action),true);assert.equal(await store.beginAction(action),false);
  await store.finishAction(g,message.messageId,'user','unknown','test_unknown');assert.equal((await store.actions(g))[0].status,'unknown');
  const reservations=await Promise.allSettled(Array.from({length:10},()=>store.reserveCall(g,3)));
  assert.equal(reservations.filter(r=>r.status==='fulfilled').length,3);assert.equal((await store.usage(g)).calls,3);
  const nonce=randomUUID();await store.createNonce(nonce,'https://example.invalid');assert.equal(await store.consumeNonce(nonce,'https://wrong.invalid'),false);assert.equal(await store.consumeNonce(nonce,'https://example.invalid'),true);assert.equal(await store.consumeNonce(nonce,'https://example.invalid'),false);
  const release=await store.acquireLeader();assert.ok(release);assert.equal(await store.acquireLeader(),null);await release();
  // Close every connection and re-open: durable state must not depend on process memory.
  const interrupted={...message,messageId:'234567892'};
  assert.equal(await store.enqueue(interrupted),true);
  const inFlight=await store.claim(); assert.equal(inFlight.message.messageId,interrupted.messageId);
  const pending={...action,messageId:interrupted.messageId};
  assert.equal(await store.beginAction(pending),true);
  await pool.end(); pool=await openMySqlPool(process.env.TEST_DATABASE_URL); store=new MySqlStore(pool);
  assert.equal(await store.seen(g,message.messageId,message.attachments[0].id),true);
  assert.equal(await store.seen(g2,message.messageId,message.attachments[0].id),false);
  assert.equal(await store.beginAction(action),false);
  assert.deepEqual(await store.actions(g2),[]);
  const recovered=await store.acquireLeader(); assert.ok(recovered);
  const recoveredJob=await store.claim(); assert.equal(recoveredJob.id,inFlight.id);
  assert.equal((await store.actions(g)).find(a=>a.messageId===interrupted.messageId).status,'unknown');
  assert.equal(await store.beginAction(pending),false);
  await store.finish(recoveredJob.id,null); await recovered();
  const raced=await Promise.all(Array.from({length:10},()=>store.beginAction({...action,messageId:'234567893'})));
  assert.equal(raced.filter(Boolean).length,1);
  assert.equal(await store.beginAction({...action,guildId:g2}),true);
  const completed=(await pool.query('SELECT message,status FROM jobs WHERE id=?',[recoveredJob.id])).rows[0];
  assert.deepEqual(completed.message,{}); assert.equal(completed.status,'done');
  // Full entity revisions, unique constraints and FK deletion restrictions.
  await assert.rejects(store.put('groups',group,0),/duplicate_record/);
  const changed={...group,name:'Updated',revision:2};await store.put('groups',changed,1);
  await assert.rejects(store.put('groups',changed,1),/revision_conflict/);
  assert.equal((await store.all('groups',g))[0].name,'Updated');
  const image={...baseRecord(g,randomUUID()),groupId:group.id};await store.put('images',image,0);
  const rule={...baseRecord(g,randomUUID()),groupId:group.id,referenceId:image.id};await store.put('rules',rule,0);
  await assert.rejects(store.put('rules',{...baseRecord(g2,randomUUID()),referenceId:image.id},0),/reference_in_use_or_wrong_guild/);
  await assert.rejects(store.remove('groups',g,group.id,2),/record_in_use/);
  await assert.rejects(store.remove('images',g,image.id,1),/record_in_use/);
  await store.put('rules',{...rule,groupId:null,referenceId:null,revision:2},1);
  await store.put('images',{...image,groupId:null,revision:2},1);
  await store.remove('groups',g,group.id,2);
  const grant={...baseRecord(g,randomUUID()),roleId:'123456789'};await store.put('grants',grant,0);
  await assert.rejects(store.put('grants',{...grant,id:randomUUID()},0),/duplicate_record/);
  await store.put('credentials',baseRecord(g,randomUUID()),0);
  await assert.rejects(store.put('credentials',baseRecord(g,randomUUID()),0),/duplicate_record/);
  // Direct malformed rows must fail CHECK; idempotent paths cannot swallow FK or truncation errors.
  const malformed=baseRecord(g2,randomUUID());
  await assert.rejects(pool.query('INSERT INTO image_groups(guild_id,id,data,revision) VALUES(?,?,?,1)',[g,malformed.id,JSON.stringify(malformed)]),e=>e.errno===3819);
  await assert.rejects(pool.query('INSERT INTO image_groups(guild_id,id,data,revision) VALUES(?,?,?,1)',[g,randomUUID(),'[]']),e=>e.errno===3819);
  await assert.rejects(pool.query('INSERT INTO guilds(id,settings) VALUES(?,?)',['bad','{}']),e=>e.errno===3819);
  await assert.rejects(store.markSeen('9999999999999999999999','123456789','123456789'),e=>e.errno===1452);
  await assert.rejects(store.markSeen(g,'1'.repeat(23),'123456789'),e=>e.code==='ER_DATA_TOO_LONG');
  // Millisecond session timestamps survive UTC conversion; expiry and delete are independent.
  const hash=randomUUID(),session={guildId:g,userId:'123456789',expiresAt:Date.now()+60000};
  await store.createSession(hash,session);assert.deepEqual(await store.session(hash),session);
  await store.deleteSession(hash);assert.equal(await store.session(hash),null);
  await store.createSession(hash,{...session,expiresAt:Date.now()-60000});assert.equal(await store.session(hash),null);
  const expired=randomUUID();await store.createNonce(expired,'https://example.invalid');
  await pool.query('UPDATE auth_nonces SET expires_at=NOW(3)-INTERVAL 1 SECOND WHERE hash=?',[expired]);
  assert.equal(await store.consumeNonce(expired,'https://example.invalid'),false);
  const once=randomUUID();await store.createNonce(once,'https://example.invalid');
  assert.equal((await Promise.all(Array.from({length:10},()=>store.consumeNonce(once,'https://example.invalid')))).filter(Boolean).length,1);
  await store.addTokens(g,123);assert.equal((await store.usage(g)).inputTokens,123);
  assert.equal((await store.usage(g)).day,new Date().toISOString().slice(0,10));
  // All pooled sessions retain strict mode and UTC; each checkout reinitializes them.
  const connections=await Promise.all(Array.from({length:5},()=>pool.connect()));
  for(const c of connections){const row=(await c.query('SELECT @@time_zone AS tz,@@sql_mode AS mode')).rows[0];assert.equal(row.tz,'+00:00');assert.ok(row.mode.includes('STRICT_ALL_TABLES'));c.release();}
  // Concurrent claimers cannot claim a job twice; nothing queued returns null.
  for(let i=0;i<12;i++)await store.enqueue({...message,messageId:String(777777700+i)});
  const claims=(await Promise.all(Array.from({length:20},()=>store.claim()))).filter(Boolean);
  assert.equal(claims.length,12);assert.equal(new Set(claims.map(j=>j.id)).size,12);assert.equal(await store.claim(),null);
  for(const job of claims)await store.finish(job.id,null);
  // Guild row locking serializes read/modify/write without lost revisions.
  await Promise.all(Array.from({length:8},()=>store.withGuild(g,async tx=>{const s=await tx.getSettings(g);await tx.putSettings(g,s.value,s.revision);})));
  assert.equal((await store.getSettings(g)).revision,10);
  // A second pool remains standby and cannot perform crash reset until elected.
  const otherPool=await openMySqlPool(process.env.TEST_DATABASE_URL),other=new MySqlStore(otherPool);
  let releaseA,releaseB;
  try {
    releaseA=await store.acquireLeader();assert.ok(releaseA);
    await store.enqueue({...message,messageId:'888888881'});const pending=await store.claim();
    assert.equal(await other.acquireLeader(),null);
    assert.equal((await pool.query('SELECT status FROM jobs WHERE id=?',[pending.id])).rows[0].status,'processing');
    await releaseA();releaseA=null;releaseB=await other.acquireLeader();assert.ok(releaseB);
    assert.equal((await other.claim()).id,pending.id);await other.finish(pending.id,null);
  } finally {await releaseA?.();await releaseB?.();await otherPool.end();}
  // Lock loss invokes onLost once; heartbeat maintains ownership while healthy.
  let lostCount=0;const lostRelease=await store.acquireLeader(()=>{lostCount++;});assert.ok(lostRelease);
  await new Promise(r=>setTimeout(r,5200));assert.equal(lostCount,0);
  const lockId=Number((await pool.query("SELECT IS_USED_LOCK('typecheck:leader') AS id")).rows[0].id);
  assert.ok(Number.isInteger(lockId)&&lockId>0);await pool.query(`KILL CONNECTION ${lockId}`);
  for(let i=0;i<100&&lostCount===0;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(lostCount,1);await lostRelease();
  const reacquired=await store.acquireLeader();assert.ok(reacquired);await reacquired();
  // Retention is per guild, removes old records only, and keeps action tombstones.
  for(const [kind,table] of [['evaluations','image_evaluations'],['events','moderation_events'],['audit','audit_events'],['calibrations','calibration_trials']]){
    const old=baseRecord(g,randomUUID()),fresh=baseRecord(g,randomUUID()),other=baseRecord(g2,randomUUID());
    await store.put(kind,old,0);await store.put(kind,fresh,0);await store.put(kind,other,0);
    await pool.query(`UPDATE ${table} SET updated_at=NOW(3)-INTERVAL 366 DAY WHERE guild_id=? AND id=?`,[g,old.id]);
    await store.maintenance();assert.equal(await store.get(kind,g,old.id),null);assert.ok(await store.get(kind,g,fresh.id));assert.ok(await store.get(kind,g2,other.id));
  }
  await pool.query("UPDATE jobs SET updated_at=NOW(3)-INTERVAL 8 DAY WHERE guild_id=? AND status='done'",[g]);
  await store.maintenance();assert.equal((await pool.query("SELECT id FROM jobs WHERE guild_id=? AND status='done'",[g])).rowCount,0);
  assert.equal((await pool.query('SELECT hash FROM sessions WHERE hash=?',[hash])).rowCount,0);
  assert.equal((await pool.query('SELECT hash FROM auth_nonces WHERE hash=?',[expired])).rowCount,0);
  assert.equal(await store.beginAction(action),false);
  // InnoDB RESTRICT checks are immediate during a parent cascade. Whole-guild
  // removal must delete rules/images first while retaining the tenant FKs.
  const linkedGroup=baseRecord(g,randomUUID()),linkedImage={...baseRecord(g,randomUUID()),groupId:linkedGroup.id};
  await store.put('groups',linkedGroup,0);await store.put('images',linkedImage,0);
  await store.put('rules',{...baseRecord(g,randomUUID()),groupId:linkedGroup.id,referenceId:linkedImage.id},0);
  await assert.rejects(pool.query('DELETE FROM guilds WHERE id=?',[g]),e=>e.errno===1451);
  assert.ok(await store.get('groups',g,linkedGroup.id));
  const deletion=await pool.connect();
  try {await deletion.query('BEGIN');await deletion.query('DELETE FROM moderation_rules WHERE guild_id=?',[g]);await deletion.query('DELETE FROM reference_images WHERE guild_id=?',[g]);await deletion.query('DELETE FROM guilds WHERE id=?',[g]);await deletion.query('COMMIT');}
  catch(e){await deletion.query('ROLLBACK');throw e;}finally{deletion.release();}
  assert.equal((await pool.query('SELECT id FROM image_groups WHERE guild_id=?',[g])).rowCount,0);
  console.log(`MySQL integration passed: ${assertions} assertions; migration retry/concurrency, tenant constraints, revisions, UTC, expiry, quota/claim/nonce concurrency, two-pool election, lock loss, leader-only reset, retention and durable no-replay.`);
} finally {await pool.query('DELETE FROM guilds WHERE id IN (?,?)',[g,g2]);await pool.end();}
