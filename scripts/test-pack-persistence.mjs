import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase,migrateDatabase } from '../dist/server/database.js';
import { ObjectStore } from '../dist/server/images.js';
import { Services } from '../dist/server/services.js';
import { Vault } from '../dist/server/security.js';
import { JevClient } from '../dist/server/jev.js';
import { Packs,exportPack } from '../dist/server/packs.js';
import { starterPack } from '../dist/server/pack-starters.js';
import { baseRecord } from '../dist/shared/domain.js';

assert.equal(process.env.ALLOW_DATABASE_TESTS,'true');
const url=new URL(process.env.TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
const {pool,store,kind}=await openDatabase(url.href), second=await openDatabase(url.href);
const guild=String(Date.now())+'41',actor=guild+'1',bot=guild+'2',channel=guild+'3',role=guild+'4';
const dir=await mkdtemp(join(tmpdir(),'typecheck-pack-db-'));
const discord={botId:bot,memberInfo:async(g,user)=>({guildId:g,userId:user,owner:false,administrator:true,roles:[]}),metadata:async()=>({channels:[{id:channel,type:0}],roles:[{id:role,name:'Test role'}]}),assertCanReadMessage:async()=>{}};
const services=new Services(store,new ObjectStore(dir),new Vault(randomBytes(32).toString('base64')),new JevClient(async()=>{throw Error('no model calls allowed');}),discord);
const packs=new Packs(services),p=await starterPack(process.cwd(),'combined-scam-setup');
try {
    await migrateDatabase(pool,kind);await migrateDatabase(pool,kind);await store.getSettings(guild);
    const preview=await packs.preview(guild,actor,p),result=await packs.apply(guild,actor,p,{},preview.token);
    assert.equal(result.added,37);assert.equal((await store.all('images',guild)).length,33);
    const persisted=await second.store.all('rules',guild);assert.equal(persisted.length,2);for(const r of persisted){assert.equal(r.automatic,false);assert.equal(r.enabled,false);assert.equal(r.approval,null);}
    assert.equal((await second.store.all('packs',guild)).length,1);assert.equal((await second.store.all('definitions',guild)).length,1);
    const again=await packs.preview(guild,actor,p);assert.equal((await packs.apply(guild,actor,p,{},again.token)).added,0);
    const s=await store.getSettings(guild);await store.withGuild(guild,tx=>tx.putSettings(guild,{...s.value,channels:[channel],exemptRoles:[role],enforcement:true,highImpactEnabled:true},s.revision));
    const exported=await exportPack(services,guild,{complete:true});assert.equal(exported.components.length,37);
    const map=Object.fromEntries(exported.policy.bindings.map(b=>[b.id,b.kind==='role'?role:channel]));const opts={policy:true,mappings:map};
    const mapped=await packs.preview(guild,actor,exported,opts);await packs.apply(guild,actor,exported,opts,mapped.token);
    assert.equal((await second.store.getSettings(guild)).value.enforcement,false);
    const stale=await packs.preview(guild,actor,p);const changed=persisted[0];await second.store.withGuild(guild,tx=>tx.put('rules',{...changed,name:'Edited in another connection',revision:2},1));
    await assert.rejects(packs.apply(guild,actor,p,{},stale.token),/preview_stale/);
    const local=await packs.preview(guild,actor,p);assert.ok(local.components.some(c=>c.status==='locally edited'));await packs.apply(guild,actor,p,{},local.token);
    assert.equal((await second.store.get('rules',guild,changed.id)).name,'Edited in another connection');
    const before=await store.all('groups',guild),newPack=await starterPack(process.cwd(),'custom-template');newPack.id='rollback-test';
    const rollback=await packs.preview(guild,actor,newPack),audit=services.audit.bind(services);
    services.audit=async(...args)=>{if(args[2]==='pack.imported')throw Error('injected_rollback');return audit(...args);};
    await assert.rejects(packs.apply(guild,actor,newPack,{},rollback.token),/injected_rollback/);services.audit=audit;
    assert.deepEqual(await second.store.all('groups',guild),before);assert.equal((await second.store.all('packs',guild)).filter(r=>r.pack==='rollback-test').length,0);
    assert.equal(await second.store.get('rules',guild+'9',changed.id),null);
    // Two processes can preview the same state, but exactly one import may commit.
    const race1=await packs.preview(guild,actor,newPack),race2=await packs.preview(guild,actor,newPack);
    const race=await Promise.allSettled([packs.apply(guild,actor,newPack,{},race1.token),packs.apply(guild,actor,newPack,{},race2.token)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    console.log(kind+': pack persistence, second-connection readback, complete round trip, mapped settings, repeat import, local edits, rollback, isolation and concurrent-preview race passed');
} finally {
    for(const table of ['moderation_rules','reference_images','image_groups']) await pool.query('DELETE FROM '+table+' WHERE guild_id='+(kind==='mysql'?'?':'$1'),[guild]);
    await pool.query('DELETE FROM guilds WHERE id='+(kind==='mysql'?'?':'$1'),[guild]);await second.pool.end();await pool.end();await rm(dir,{recursive:true,force:true});
}
