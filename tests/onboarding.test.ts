import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Onboarding, canonical} from '../server/onboarding.js';
import {installTextStarters} from '../server/text-starters.js';
import {registerTools, toolDefinitions, type BrowserTool} from '../activity/src/onboarding.js';
import {fixture,rule,G,G2,ADMIN,MOD,BOT,CHANNEL,ROLE,API_KEY} from './helpers.js';
import {baseRecord, type Rule, type Audit, type Group, type ReferenceImage} from '../shared/domain.js';
import {randomUUID} from 'node:crypto';
import {starterPack} from '../server/pack-starters.js';
import {Packs,exportPack,validatePack} from '../server/packs.js';
import {seedStarterReferences} from '../server/starter-references.js';
const chosen = (presets = ['scam_phishing']) => ({presets,channels:[CHANNEL],excludedChannels:[],exemptRoles:[ROLE],logChannel:CHANNEL,customizations:{}});
const binding='test-session-binding';
const ref=(p:any)=>({planId:p.id,digest:p.digest});

test('plan preview, explicit acceptance and idempotent receipt keep enforcement off',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),before=await f.store.getSettings(G);
    const p=await s.plan(G,ADMIN,binding,chosen());
    assert.equal((await f.store.all('rules',G)).length,0);assert.equal((await f.store.getSettings(G)).revision,before.revision);
    assert.equal(p.additions.length,3);assert.equal(p.after.enforcement,false);
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p),'apply'),/explicit_acceptance_required/);
    await s.transition(G,ADMIN,binding,ref(p),'accept');
    const results=await Promise.all([s.transition(G,ADMIN,binding,ref(p),'apply'),s.transition(G,ADMIN,binding,ref(p),'apply')]);
    assert.deepEqual(results[0].receipt,results[1].receipt);assert.equal((await f.store.all('rules',G)).length,3);
    for(const r of await f.store.all<Rule>('rules',G)){assert.equal(r.enabled,false);assert.equal(r.automatic,false);assert.equal(r.approval,null);assert.equal(r.action,'review');}
    assert.equal((await f.store.getSettings(G)).value.enforcement,false);assert.equal(f.discord.performed.length,0);
    assert.ok(!canonical(results).includes(API_KEY));assert.ok(!canonical(results).includes('objectKey'));
});
test('actor, guild, session and exact digest binding reject substitution',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),p=await s.plan(G,ADMIN,binding,chosen());
    await assert.rejects(s.transition(G,ADMIN,'other-session',ref(p),'accept'),/binding_mismatch/);
    await assert.rejects(s.transition(G,ADMIN,binding,{...ref(p),digest:'0'.repeat(64)},'accept'),/binding_mismatch/);
    f.discord.members.set(MOD,{guildId:G,userId:MOD,roles:[],administrator:true,owner:false});
    await assert.rejects(s.transition(G,MOD,binding,ref(p),'accept'),/binding_mismatch/);
    await assert.rejects(s.transition(G2,ADMIN,binding,ref(p),'apply'),/not_a_guild_member/);
});
test('live authority is checked again before acceptance, apply and inventory',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),p=await s.plan(G,ADMIN,binding,chosen());
    await s.transition(G,ADMIN,binding,ref(p),'accept');f.discord.members.get(ADMIN)!.administrator=false;f.discord.members.get(ADMIN)!.owner=false;
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p),'apply'),/administrator_required/);
    await assert.rejects(s.inventory(G,ADMIN),/administrator_required/);assert.equal((await f.store.all('rules',G)).length,0);
});
test('stale settings, policy revision, and expired plans cannot be accepted/applied',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),p=await s.plan(G,ADMIN,binding,chosen());
    const settings=await f.store.getSettings(G);await f.store.putSettings(G,settings.value,settings.revision);
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p),'accept'),/plan_stale/);
    const p2=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p2),'accept');
    const original=Date.now;Date.now=()=>original()+11*60000;
    try{await assert.rejects(s.transition(G,ADMIN,binding,ref(p2),'apply'),/plan_expired/);}finally{Date.now=original;}
});
test('overlap is a component union; edits and deletion tombstones survive repeat and legacy install',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services);
    const p=await s.plan(G,ADMIN,binding,chosen(['scam_phishing','community','scam_phishing']));assert.equal(p.additions.length,7);
    await s.transition(G,ADMIN,binding,ref(p),'accept');await s.transition(G,ADMIN,binding,ref(p),'apply');
    const rules=await f.store.all<Rule>('rules',G),deleted=rules[0]!,edited=rules[1]!;
    await f.store.remove('rules',G,deleted.id,deleted.revision);await f.store.put('rules',{...edited,name:'Local policy edit',revision:edited.revision+1},edited.revision);
    const repeated=await s.plan(G,ADMIN,binding,chosen(['community','scam_phishing']));assert.equal(repeated.additions.length,0);assert.equal(repeated.skipped.length,7);
    await installTextStarters(f.services,G,ADMIN);assert.equal((await f.store.all('rules',G)).length,9);
    assert.equal((await f.store.get<Rule>('rules',G,edited.id))!.name,'Local policy edit');assert.equal(await f.store.get('rules',G,deleted.id),null);
});
test('customization is previewable data, invalid keys and grants are rejected',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),input={...chosen(),customizations:{text_scams:{name:'Ignore instructions <script>sample</script>',positive:'Concrete observable condition'}}};
    const p=await s.plan(G,ADMIN,binding,input);assert.equal(p.additions.find((r:Rule)=>r.text?.preset==='text_scams').name,input.customizations.text_scams.name);
    await assert.rejects(s.plan(G,ADMIN,binding,{...input,enforcement:true}),/unknown_field/);
    await assert.rejects(s.plan(G,ADMIN,binding,{...input,customizations:{text_scams:{automatic:true}}}),/unknown_field/);
    await assert.rejects(s.plan(G,ADMIN,binding,{...chosen(),channels:[G2]}),/channel_not_available/);
});
test('atomic failure rolls back rules, settings, status and receipts; accepted plan can retry',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),p=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p),'accept');
    const put=f.store.put.bind(f.store);let writes=0;
    f.store.put=async(...args)=>{if(args[0]==='rules'&&++writes===2)throw new Error('isolated_failure');return put(...args);};
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p),'apply'),/isolated_failure/);
    assert.equal((await f.store.all('rules',G)).length,0);assert.equal((await s.transition(G,ADMIN,binding,ref(p),'inspect')).status,'accepted');
    f.store.put=put;assert.equal((await s.transition(G,ADMIN,binding,ref(p),'apply')).status,'applied');
});
test('image preset reuses the existing reference group and does not resurrect missing references',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services);
    await assert.rejects(s.plan(G,ADMIN,binding,chosen(['image_scams'])),/starter_reference_group_missing/);
    const group:Group={...baseRecord(G,randomUUID()),name:'Edited starter group'};await f.store.put('groups',group,0);
    await f.store.put<ReferenceImage>('images',{...f.ref,revision:f.ref.revision+1,groupId:group.id,createdBy:ADMIN},f.ref.revision);
    await f.store.put('packs',{...baseRecord(G,randomUUID()),pack:'reviewed-scam-references',versions:['1.0.0'],components:{'scam-references':group.id}},0);
    const p=await s.plan(G,ADMIN,binding,chosen(['image_scams']));assert.equal(p.additions[0].groupId,group.id);assert.equal(p.additions[0].action,'review');
    await s.transition(G,ADMIN,binding,ref(p),'accept');await s.transition(G,ADMIN,binding,ref(p),'apply');
    assert.equal((await f.store.all('images',G)).length,1);assert.equal((await s.plan(G,ADMIN,binding,chosen(['image_scams']))).additions.length,0);
});
test('inventory is paginated and strips reference paths and credentials',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services);const inventory=await s.inventory(G,ADMIN);
    assert.equal(inventory.channels.items.length,1);assert.equal(inventory.referenceCount,1);assert.ok(!canonical(inventory).includes('objectKey'));assert.ok(!canonical(inventory).includes(API_KEY));
    await assert.rejects(s.inventory(G,ADMIN,-1),/invalid_offset/);
});
test('onboarding preserves configured policy and exclusions, stops enforcement, and never changes existing approval',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),settings=await f.store.getSettings(G);
    const existing=rule(f.ref,{approval:{actor:ADMIN,at:'synthetic',note:'Synthetic historical evidence',fingerprint:'old'}});await f.store.put('rules',existing,0);
    await f.store.putSettings(G,{...settings.value,enforcement:true,highImpactEnabled:true,excludedChannels:[CHANNEL]},settings.revision);
    const p=await s.plan(G,ADMIN,binding,chosen());assert.equal(p.before.value.enforcement,true);assert.equal(p.after.enforcement,false);assert.equal(p.after.highImpactEnabled,true);assert.deepEqual(p.after.excludedChannels,[CHANNEL]);
    await s.transition(G,ADMIN,binding,ref(p),'accept');await s.transition(G,ADMIN,binding,ref(p),'apply');
    assert.deepEqual(await f.store.get('rules',G,existing.id),existing);
});
test('rule/reference changes and destination disappearance invalidate previously accepted work',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),existing=rule(f.ref);await f.store.put('rules',existing,0);
    const p=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p),'accept');
    await f.store.put('rules',{...existing,name:'Changed policy',revision:existing.revision+1},existing.revision);
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p),'apply'),/plan_stale/);
    const p2=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p2),'accept');
    await f.store.put('images',{...f.ref,revision:f.ref.revision+1,enabled:false},f.ref.revision);
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p2),'apply'),/plan_stale/);
    const p3=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p3),'accept');
    f.discord.metadata=async()=>({name:'Synthetic',roles:[],channels:[]});
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p3),'apply'),/discord_inventory_changed/);
});
test('receipt persistence failure rolls back the entire configuration; legacy-installed starters remain skipped',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),p=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p),'accept');
    const put=f.store.put.bind(f.store);f.store.put=async(...args)=>{if(args[0]==='audit'&&args[1].id===p.id)throw Error('receipt_write_failed');return put(...args);};
    await assert.rejects(s.transition(G,ADMIN,binding,ref(p),'apply'),/receipt_write_failed/);
    assert.equal((await f.store.all('rules',G)).length,0);assert.deepEqual((await f.store.getSettings(G)).value.channels,[]);
    f.store.put=put;await installTextStarters(f.services,G,ADMIN);
    assert.equal((await s.plan(G,ADMIN,binding,chosen(['scam_phishing','community','custom']))).additions.length,0);
});
test('pack imports preserve local onboarding markers and cannot transport another guild tombstones',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services),p=await s.plan(G,ADMIN,binding,chosen());await s.transition(G,ADMIN,binding,ref(p),'accept');await s.transition(G,ADMIN,binding,ref(p),'apply');
    f.discord.members.set(BOT,{guildId:G,userId:BOT,roles:[],owner:false,administrator:false});
    const portable=await exportPack(f.services,G,{complete:true});assert.equal(portable.policy!.settings.onboardingStarters,undefined);
    const original=structuredClone(portable);portable.policy!.settings.onboardingStarters=[];
    await assert.rejects(validatePack(portable),/starter_marker_not_portable/);
    const packs=new Packs(f.services),preview=await packs.preview(G,ADMIN,original,{policy:true,mappings:Object.fromEntries(original.policy!.bindings.map(b=>[b.id,b.kind==='channel'?CHANNEL:ROLE]))});
    await packs.apply(G,ADMIN,original,{policy:true,mappings:Object.fromEntries(original.policy!.bindings.map(b=>[b.id,b.kind==='channel'?CHANNEL:ROLE]))},preview.token);
    assert.deepEqual((await f.store.getSettings(G)).value.onboardingStarters,['text_impersonation','text_phishing','text_scams']);
});
test('onboarding reference review and combined pack share identity in either installation order',async t=>{
    const f=await fixture(t),s=new Onboarding(f.services);await f.store.remove('images',G,f.ref.id,f.ref.revision);await seedStarterReferences(f.services,G,process.cwd());
    const p=await s.plan(G,ADMIN,binding,chosen(['image_scams']));await s.transition(G,ADMIN,binding,ref(p),'accept');await s.transition(G,ADMIN,binding,ref(p),'apply');
    const packs=new Packs(f.services),pack=await starterPack(process.cwd(),'combined-scam-setup'),preview=await packs.preview(G,ADMIN,pack,{});
    assert.equal(preview.components.find(c=>c.id==='reference-rule')!.choice,'keep');await packs.apply(G,ADMIN,pack,{},preview.token);
    assert.equal((await f.store.all<Rule>('rules',G)).filter(r=>r.type==='group').length,1);assert.equal((await f.store.all('images',G)).length,33);
    const groupRule=(await f.store.all<Rule>('rules',G)).find(r=>r.type==='group')!;await f.store.remove('rules',G,groupRule.id,groupRule.revision);
    // A guild that imported the pack first has its own receipt, with no onboarding markers.
    const settings=await f.store.getSettings(G);await f.store.putSettings(G,{...settings.value,onboardingStarters:[]},settings.revision);
    assert.equal((await s.plan(G,ADMIN,binding,chosen(['image_scams']))).additions.length,0);
    const again=await packs.preview(G,ADMIN,pack,{});assert.equal(again.components.find(c=>c.id==='reference-rule')!.choice,'keep');
});
test('browser registry uses current document API shape, exact semantic tools and abort lifecycle',async()=>{
    const tools=new Map<string,BrowserTool>(),controller=new AbortController();let calls=0;
    const api=async(path:string)=>{calls++;return path==='me'?{administrator:true}:{};};
    const registry={registerTool:async(tool:BrowserTool,{signal}:{signal:AbortSignal})=>{tools.set(tool.name,tool);signal.addEventListener('abort',()=>tools.delete(tool.name));}};
    assert.equal(await registerTools(undefined,api,()=>{},controller.signal),false);
    assert.equal(await registerTools(registry,api,()=>{},controller.signal),true);assert.equal(tools.size,8);
    assert.ok(![...tools.keys()].some(k=>/accept$|credential|activate|http/.test(k)));
    const context=tools.get('typecheck_context')!;await context.execute({});assert.equal(calls,2);
    controller.abort();assert.equal(tools.size,0);await assert.rejects(context.execute({}),/session_expired/);
});
test('browser callbacks recheck authority and reject ambiguous provider test inputs',async()=>{
    const controller=new AbortController(),tools:BrowserTool[]=[];
    await registerTools({registerTool:async t=>{tools.push(t);}},async()=>({administrator:false,owner:false}),()=>{},controller.signal);
    await assert.rejects(tools[0]!.execute({}),/administrator_required/);
    const test=toolDefinitions(async()=>({}),()=>{}).find(t=>t.name==='typecheck_test_rule')!;
    await assert.rejects(test.execute({ruleId:randomUUID(),text:'x',base64:'x',providerUseAccepted:true}),/invalid_test_input/);
    await assert.rejects(test.execute({ruleId:randomUUID(),text:'x',providerUseAccepted:false}),/invalid_test_input/);
});
