import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Services } from '../dist/server/services.js';
import { installTextStarters } from '../dist/server/text-starters.js';
import { TEXT_STARTERS } from '../dist/shared/text-starters.js';
import { parseRule, baseRecord } from '../dist/shared/domain.js';
import { textDigest } from '../dist/server/text.js';
export async function textPersistence(store,pool,kind,guild) {
 const services=new Services(store,null,null,null,null);
 const s=await store.getSettings(guild);assert.equal(s.value.textModerationEnabled,false);
 const r={...baseRecord(guild,randomUUID()),...parseRule({name:'Text persistence',type:'text',text:TEXT_STARTERS[0].definition,referenceId:null,groupId:null,mode:'exact',threshold:.9,action:'review',timeoutSeconds:600,deleteMessage:false,priority:0,enabled:false,automatic:false,secondVerification:true,reason:'Synthetic persistence only'}),approval:null};
 await store.put('rules',r,0);assert.deepEqual((await store.get('rules',guild,r.id)).text,r.text);
 await Promise.all([installTextStarters(services,guild,'test'),installTextStarters(services,guild,'test')]);
 let rules=await store.all('rules',guild);assert.equal(rules.length,TEXT_STARTERS.length);assert.equal(new Set(rules.map(r=>r.text.preset)).size,TEXT_STARTERS.length);assert.ok(rules.every(r=>!r.enabled&&!r.automatic&&!r.approval));
 assert.ok((await store.getSettings(guild)).value.onboardingStarters.includes(r.text.preset));
 await store.remove('rules',guild,r.id,1);await installTextStarters(services,guild,'test');assert.equal((await store.all('rules',guild)).length,TEXT_STARTERS.length-1);
 const message={guildId:guild,channelId:'123456789',messageId:'234567899',userId:'345678912',bot:false,webhook:false,attachments:[],textDigest:textDigest('transient synthetic sample')};
 assert.equal(await store.enqueue(message),true);assert.equal(await store.enqueue(message),false);assert.equal(await store.enqueue({...message,textDigest:textDigest('edited sample')}),true);
 const placeholder=kind==='mysql'?'?':'$1';const rows=(await pool.query(`SELECT message FROM jobs WHERE guild_id=${placeholder}`,[guild])).rows;
 assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes('transient synthetic sample'));assert.ok(rows.every(r=>!('content' in (typeof r.message==='string'?JSON.parse(r.message):r.message))));
 const before=await store.getSettings(guild);await assert.rejects(store.withGuild(guild,async tx=>{await tx.putSettings(guild,{...before.value,textModerationEnabled:true},before.revision);throw Error('rollback');}));assert.equal((await store.getSettings(guild)).value.textModerationEnabled,false);
 await pool.query(`DELETE FROM guilds WHERE id=${placeholder}`,[guild]);console.log('PASS native text JSON persistence, concurrent starter installation, deletion, digest edit deduplication and rollback');
}
