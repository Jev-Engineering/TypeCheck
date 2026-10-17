// Dedicated disposable database only; never uses production environment configuration.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {openPool,PostgresStore} from '../dist/server/postgres.js';
import {openMySqlPool,MySqlStore} from '../dist/server/mysql.js';
import {migrateDatabase} from '../dist/server/database.js';
import {Onboarding} from '../dist/server/onboarding.js';
import {Services} from '../dist/server/services.js';
import {Vault} from '../dist/server/security.js';
import {baseRecord} from '../dist/shared/domain.js';
assert.equal(process.env.ALLOW_DATABASE_TESTS,'true');
const url=new URL(process.env.TEST_DATABASE_URL);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/guard_test');
const mysql=url.protocol==='mysql:';assert.ok(mysql||url.protocol==='postgresql:');
const pool=await(mysql?openMySqlPool:openPool)(url.href),store=mysql?new MySqlStore(pool):new PostgresStore(pool);
const guild=String(Date.now())+'81',actor=String(Date.now())+'82',channel=String(Date.now())+'83';
const discord={memberInfo:async()=>({guildId:guild,userId:actor,roles:[],owner:true,administrator:true}),metadata:async()=>({name:'Synthetic DB guild',roles:[],channels:[{id:channel,type:0}]}),online:false};
const services=new Services(store,null,new Vault(randomBytes(32).toString('base64')),null,discord),onboarding=new Onboarding(services);
const input={presets:['scam_phishing','community'],channels:[channel],excludedChannels:[],exemptRoles:[],logChannel:channel,customizations:{}},binding='isolated-db-session';
const ref=p=>({planId:p.id,digest:p.digest});
try{
    await migrateDatabase(pool,mysql?'mysql':'postgres');
    const p=await onboarding.plan(guild,actor,binding,input);assert.equal(p.additions.length,7);
    await assert.rejects(onboarding.transition(guild,actor,'wrong',ref(p),'accept'),/binding_mismatch/);
    await onboarding.transition(guild,actor,binding,ref(p),'accept');
    // Failure after a rule insert must leave neither policy nor a receipt committed.
    const withGuild=store.withGuild.bind(store);let fail=true;
    store.withGuild=workaround;
    async function workaround(g,work){return withGuild(g,async tx=>{const put=tx.put.bind(tx);let writes=0;tx.put=async(...args)=>{if(fail&&args[0]==='rules'&&++writes===2)throw Error('injected_atomic_failure');return put(...args);};return work(tx);});}
    await assert.rejects(onboarding.transition(guild,actor,binding,ref(p),'apply'),/injected_atomic_failure/);
    assert.equal((await store.all('rules',guild)).length,0);assert.equal((await onboarding.transition(guild,actor,binding,ref(p),'inspect')).status,'accepted');
    fail=false;store.withGuild=withGuild;
    const [a,b]=await Promise.all([onboarding.transition(guild,actor,binding,ref(p),'apply'),onboarding.transition(guild,actor,binding,ref(p),'apply')]);
    assert.deepEqual(a.receipt,b.receipt);assert.equal((await store.all('rules',guild)).length,7);
    assert.equal((await store.getSettings(guild)).value.enforcement,false);
    // New service instance recovers committed receipt from SQL, not process memory.
    assert.deepEqual((await new Onboarding(services).transition(guild,actor,binding,ref(p),'apply')).receipt,a.receipt);
    const rules=await store.all('rules',guild);await store.remove('rules',guild,rules[0].id,rules[0].revision);
    assert.equal((await onboarding.plan(guild,actor,binding,input)).additions.length,0);
    const stale=await onboarding.plan(guild,actor,binding,input),settings=await store.getSettings(guild);
    await store.putSettings(guild,settings.value,settings.revision);
    await assert.rejects(onboarding.transition(guild,actor,binding,ref(stale),'accept'),/plan_stale/);
    const record=await store.get('audit',guild,p.id);assert.equal(await store.get('audit',actor,p.id),null);
    assert.equal(record.detail.status,'applied');
    console.log(`${mysql?'MySQL':'PostgreSQL'} onboarding: canonical JSON plans, binding, explicit acceptance, rollback, concurrent apply, persisted receipts, tombstones, stale rejection and isolation passed.`);
}finally{
    const q=mysql?'?':'$1';await pool.query(`DELETE FROM moderation_rules WHERE guild_id=${q}`,[guild]);await pool.query(`DELETE FROM guilds WHERE id=${q}`,[guild]);await pool.end();
}
