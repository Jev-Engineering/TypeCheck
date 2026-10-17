// Isolated, review-only diagnostic runner. No Discord client or production writes.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,appendFileSync,openSync,closeSync,fsyncSync,existsSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {EXPERIMENT_VERSION,experimentTransport,evidenceDecision,summarizeDecisions} from './benchmark-variants.mjs';

const root=resolve(process.env.BENCHMARK_ROOT??'G:/datasets-deleteme/typecheck');
const run=resolve(root,'experiments/evidence-v2'), runtime=resolve(run,'runtime');
const load=name=>import(pathToFileURL(resolve(runtime,name)).href);
const {JevClient}=await load('server/jev.js');
const {normalize,NORMALIZATION_HASH_VERSION}=await load('server/images.js');
const {textEligibility,textDigest}=await load('server/text.js');
const {textBoundary}=await load('shared/text.js');
const {contentEligibility}=await load('server/content.js');
const {estimate,money,parseRate}=await load('shared/analytics.js');
const {safeError}=await load('server/security.js');
const sharp=createRequire(resolve(runtime,'package.json'))('sharp');
const sha=x=>createHash('sha256').update(x).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const model='jev-1.14.0', threshold=.9, maxAttempts=600, maxInputTokens=10000000;
const key=process.env.TYPESAFE_EVAL_KEY;
if(!key||process.env.ALLOW_PAID_BENCHMARK_EXPERIMENTS!=='true') throw Error('explicit_paid_experiment_authorization_required');
const frozen=JSON.parse(readFileSync(resolve(run,'freeze.json'),'utf8'));
const manifestBytes=readFileSync(resolve(run,'diagnostic-manifest.json'));
if(sha(manifestBytes)!==frozen.diagnosticSha256) throw Error('diagnostic_manifest_changed');
const cases=JSON.parse(manifestBytes);
if(cases.some(c=>c.split!=='diagnostic_tuning_only')) throw Error('protected_holdout_requires_separate_review_and_frozen_candidate');
const policies=JSON.parse(readFileSync(resolve(run,'baseline-policies.json'),'utf8'));
const price=JSON.parse(readFileSync(resolve(run,'pricing.json'),'utf8'));
const rate=parseRate({model,revision:1,currency:price.currency,perMillion:price.perMillion,effectiveAt:price.effectiveAt,note:'Public list-price benchmark estimate; not an invoice.'});
const focused={...policies.contentPolicy,preset:'custom',question:'Does the image visibly ask a recipient to enter or share an authentication secret?',
  positive:'Visible requests for a password, recovery/authentication code, seed phrase or authentication token.',
  negative:'No such visible request; a logo, advertisement or ordinary contact information alone is negative.',
  exceptions:'This is an observation about visible requests, not a claim that a website is malicious. Do not infer identity, actual fraud, ownership or private intent. Warning/educational framing can depict a request without endorsing it.',
  contextRequirements:'Use visible evidence only. Decide whether the request is depicted, not whether the posting author endorses it.',requirePromotion:false,requireReadableText:true,supporting:[]};
mkdirSync(resolve(run,'controls'),{recursive:true});
const lockPath=resolve(run,'run.lock');const lock=openSync(lockPath,'wx');writeFileSync(lock,JSON.stringify({pid:process.pid}));closeSync(lock);
process.on('exit',()=>{if(existsSync(lockPath))unlinkSync(lockPath);});
let stop=false;process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
function durable(name,row){const fd=openSync(resolve(run,name),'a');try{appendFileSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(name,value){const p=resolve(run,name),tmp=p+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));for(let n=0;;n++){try{renameSync(tmp,p);return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||n===99)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}}}
function lines(name){const p=resolve(run,name);return existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];}
const results=lines('results.jsonl'),events=lines('attempts.jsonl'),done=new Set(results.map(r=>r.id));
const settled=new Set(events.filter(e=>e.event==='completed').map(e=>e.id));
if(events.some(e=>e.event==='reserved'&&(!settled.has(e.id)||!done.has(e.caseId))))throw Error('unreconciled_external_attempt_or_case_result');
let attempts=events.filter(e=>e.event==='reserved').length;
let tokens=events.filter(e=>e.event==='completed').reduce((n,e)=>n+(e.inputTokens??0),0);
let unknown=events.filter(e=>e.event==='completed'&&e.inputTokens==null).length;
let cost=events.filter(e=>e.event==='completed').reduce((n,e)=>n+BigInt(e.costMicros??0),0n);
let current=null,failure=null,consecutiveErrors=0;
const baselineClient=new JevClient(), evidenceClient=new JevClient(experimentTransport());
const plan=[];
for(const c of cases.filter(c=>c.kind!=='reference')){
  plan.push({...c,variant:'answerability_v2',profile:'v2',imageSize:768});
  if(c.kind==='content'&&Number(c.auditId.slice(-4))%2===0){
    plan.push({...c,variant:'detail_1536',profile:'production',imageSize:1536});
    plan.push({...c,variant:'visible_credential_request',profile:'production',imageSize:768,expected:null,labelType:'pending_independent_observable_policy_label'});
  }
}
const anchors=cases.filter(c=>c.kind==='reference').slice(0,10);
for(let i=0;i<anchors.length;i++){
  const c=anchors[i],other=anchors[(i+1)%anchors.length];
  for(const variant of ['exact_hash_control','resize_control','crop_control','collage_control','different_source_control'])
    plan.push({...c,kind:'reference',variant,anchor:other.reference,expected:variant!=='different_source_control',labelType:variant==='different_source_control'?'different_source_proxy':'controlled_transform_known_source',profile:'production',imageSize:768});
}
for(const task of plan)task.taskId=task.variant+':'+task.auditId;
const config={version:EXPERIMENT_VERSION,model,threshold,negativeThreshold:.1,manifestSha256:frozen.diagnosticSha256,baselinePoliciesSha256:sha(readFileSync(resolve(run,'baseline-policies.json'))),variantsModuleSha256:sha(readFileSync(new URL('./benchmark-variants.mjs',import.meta.url))),runtimeHashVersion:NORMALIZATION_HASH_VERSION,focusedPolicy:focused,plan:plan.map(t=>({id:t.taskId,variant:t.variant,sourceGroup:t.sourceGroup,expected:t.expected})),maxAttempts,maxInputTokens};
const configHash=sha(JSON.stringify(config));
const configPath=resolve(run,'experiment-config.json');
if(existsSync(configPath)&&JSON.parse(readFileSync(configPath)).configHash!==configHash)throw Error('frozen_experiment_configuration_changed');
atomic('experiment-config.json',{...config,configHash,automaticActions:false,goldLabelsAccepted:false,split:'diagnostic_tuning_only'});

function report(state){
  const groups={};for(const variant of [...new Set(results.map(r=>r.variant))])for(const kind of ['text','content','reference']){
    const group=results.filter(r=>r.variant===variant&&r.kind===kind);if(!group.length)continue;
    groups[variant+':'+kind]={...summarizeDecisions(group),labelBasis:variant==='visible_credential_request'?'awaiting independent annotations':'source proxy or controlled transform, not independent gold',providerTokens:group.reduce((n,r)=>n+(r.answer?.inputTokens??0),0)};
  }
  atomic('status.json',{state,pid:process.pid,updatedAt:new Date().toISOString(),completed:results.length,planned:plan.length,current,attempts,maxAttempts,tokens,maxInputTokens,unknownUsage:unknown,estimatedUSD:money(cost.toString()),failure,configHash,productionActions:false,goldAccuracyAccepted:false,groups});
}
function callbacks(task){return{onAttempt:async info=>{if(!info||attempts>=maxAttempts||tokens>=maxInputTokens||stop)throw Error('experiment_budget_exhausted');attempts++;durable('attempts.jsonl',{event:'reserved',caseId:task.taskId,kind:task.kind,model,pricing:price,...info});},onDispatch:async id=>durable('attempts.jsonl',{event:'dispatching',id,caseId:task.taskId}),onComplete:async(id,completion)=>{const amount=estimate(completion.inputTokens,rate);durable('attempts.jsonl',{event:'completed',id,caseId:task.taskId,...completion,costMicros:amount});tokens+=completion.inputTokens??0;unknown+=completion.inputTokens==null?1:0;cost+=BigInt(amount??0);}};}
async function detail(input,size){const normalized=await normalize(input);if(size===768)return normalized;const bytes=await sharp(input,{limitInputPixels:24000000,failOn:'error'}).rotate().resize(size,size,{fit:'contain',background:'#ffffff'}).flatten({background:'#ffffff'}).jpeg({quality:90}).toBuffer();return{bytes,sha256:sha(bytes),hashVersion:'analysis-detail-1536-v1'};}
async function controlled(task){
  const raw=readFileSync(task.reference),ref=await normalize(raw);let bytes,mode='partial';
  if(task.variant==='exact_hash_control')return{bytes:ref.bytes,ref,mode:'exact'};
  if(task.variant==='different_source_control')return{bytes:(await normalize(readFileSync(task.anchor))).bytes,ref,mode};
  if(task.variant==='resize_control'){bytes=await sharp(raw).rotate().resize(384,384,{fit:'inside'}).jpeg({quality:65}).toBuffer();mode='exact';}
  if(task.variant==='crop_control'){const base=await sharp(raw).rotate().toBuffer();const m=await sharp(base).metadata();const x=Math.max(1,Math.floor(m.width*.03)),y=Math.max(1,Math.floor(m.height*.03));bytes=await sharp(base).extract({left:x,top:y,width:m.width-2*x,height:m.height-2*y}).jpeg({quality:90}).toBuffer();mode='transformed';}
  if(task.variant==='collage_control'){const other=await normalize(readFileSync(task.anchor));bytes=await sharp({create:{width:1536,height:1536,channels:3,background:'#ffffff'}}).composite([{input:ref.bytes,left:0,top:0},{input:other.bytes,left:768,top:768}]).jpeg({quality:90}).toBuffer();}
  const path=resolve(run,'controls',task.taskId.replaceAll(':','-')+'.jpg');writeFileSync(path,bytes);return{bytes:(await normalize(bytes)).bytes,ref,mode};
}
try{
  report('running');
  for(const task of plan){
    if(done.has(task.taskId))continue;
    if(stop||existsSync(resolve(run,'STOP'))||attempts>=maxAttempts||tokens>=maxInputTokens){report('stopped_at_limit_or_request');break;}
    current=task.taskId;report('running');const started=Date.now();
    let row={id:task.taskId,auditId:task.auditId,variant:task.variant,kind:task.kind,expected:task.expected,labelType:task.labelType,sourceGroup:task.sourceGroup,configHash,model,threshold,predicted:null};
    try{
      const options={key,model,mode:'exact',...callbacks(task)};const client=task.profile==='v2'?evidenceClient:baselineClient;
      if(task.kind==='text'){
        const boundary=textBoundary(task.text);if(boundary)row.boundary=boundary;
        else{const answer=await client.analyzeText(task.text,policies.textPolicy,options);const gate=evidenceDecision(answer,policies.textPolicy,'text',textEligibility);row={...row,answer,gate,predicted:gate.status==='insufficient_evidence'?null:gate.eligible,sampleSha256:textDigest(task.text)};}
      }else if(task.kind==='content'){
        const image=await detail(readFileSync(task.file),task.imageSize);const definition=task.variant==='visible_credential_request'?focused:policies.contentPolicy;
        const answer=await client.analyze(image.bytes,definition,undefined,options);
        const gate=task.profile==='v2'?evidenceDecision(answer,definition,'content',contentEligibility):contentEligibility(answer,definition,threshold);
        row={...row,answer,gate,predicted:gate.status==='insufficient_evidence'?null:gate.eligible,sampleSha256:image.sha256,imageSize:task.imageSize,normalizationVersion:image.hashVersion};
      }else{
        const {bytes,ref,mode}=await controlled(task);const sampleHash=sha(bytes);
        if(sampleHash===ref.sha256)row={...row,predicted:true,provenance:'exact_hash',model:null,probability:null,verified:false,providerCalls:0,sampleSha256:sampleHash,referenceSha256:ref.sha256,hashVersion:NORMALIZATION_HASH_VERSION};
        else{const answer=await client.compare(bytes,ref.bytes,{...options,mode});row={...row,answer,predicted:answer.probability>=threshold,provenance:'jev',sampleSha256:sampleHash,referenceSha256:ref.sha256,mode};}
      }
    }catch(error){row.error=safeError(error);if(['jev_authentication_failed','jev_rate_limit_deferred'].includes(row.error))throw error;}
    row.elapsedMs=Date.now()-started;durable('results.jsonl',row);results.push(row);done.add(task.taskId);current=null;report('running');
    consecutiveErrors=row.error?consecutiveErrors+1:0;
    if(consecutiveErrors>=5)throw Error('five_consecutive_experiment_failures');
    await sleep(1000);
  }
  if(done.size===plan.length)report('completed');
}catch(error){failure=safeError(error);report('blocked');process.exitCode=1;console.error(JSON.stringify({failure,current,completed:done.size}));}
finally{if(existsSync(lockPath))unlinkSync(lockPath);}
