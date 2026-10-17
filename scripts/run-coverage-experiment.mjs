import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,appendFileSync,openSync,closeSync,fsyncSync,existsSync,mkdirSync,renameSync,unlinkSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {experimentTransport,evidenceDecision,summarizeDecisions} from './benchmark-variants.mjs';
import {clarifiedTransport,clarifyText,observablePolicy,selectAbstentions,summarizeSweep} from './coverage-experiment.mjs';

const command=process.argv[2];
if(!['--prepare','--run','--analyze','--repair-local-signal-limit'].includes(command))throw Error('usage: --prepare | --run | --analyze | --repair-local-signal-limit');
const root=resolve(process.env.BENCHMARK_ROOT??'G:/datasets-deleteme/typecheck');
const source=resolve(root,'repeats/20261017-repeat-01/experiments/evidence-v2');
const run=resolve(root,'experiments/coverage-v3'),runtime=resolve(source,'runtime');
const sha=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const lines=p=>existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
const load=p=>import(pathToFileURL(resolve(runtime,p)).href);
const {JevClient}=await load('server/jev.js');
const {normalize,NORMALIZATION_HASH_VERSION}=await load('server/images.js');
const {textEligibility}=await load('server/text.js');
const {contentEligibility}=await load('server/content.js');
const {estimate,money,parseRate}=await load('shared/analytics.js');
const {safeError}=await load('server/security.js');
const sharp=createRequire(resolve(runtime,'package.json'))('sharp');
const policies=read(resolve(source,'baseline-policies.json'));
const price=read(resolve(source,'pricing.json'));
const sourceRows=lines(resolve(source,'results.jsonl'));
const cases=read(resolve(source,'diagnostic-manifest.json'));
if(read(resolve(source,'status.json')).state!=='completed')throw Error('source_not_completed');
if(sha(readFileSync(resolve(source,'diagnostic-manifest.json')))!==read(resolve(source,'freeze.json')).diagnosticSha256)throw Error('source_manifest_changed');
const gates={text:textEligibility,content:contentEligibility};
const model='jev-1.14.0',maxAttempts=600,maxInputTokens=10000000;
const rate=parseRate({model,revision:1,currency:price.currency,perMillion:price.perMillion,effectiveAt:price.effectiveAt,note:'Frozen public list-price estimate, not an invoice.'});
const plan=selectAbstentions(cases,sourceRows);
const refs=cases.filter(c=>c.kind==='reference');
// A larger diagnostic control set, with negative source pairs per comparison mode.
for(let i=0;i<Math.min(30,refs.length);i++)for(const variant of ['exact_hash_control','resize_control','crop_control','collage_control'])
  plan.push({...refs[i],variant,anchor:refs[(i+1)%refs.length].reference,expected:true,labelType:'controlled_transform_known_source'});
for(const [mode,offset] of [['exact',1],['transformed',7],['partial',19]])for(let i=0;i<refs.length;i++)
  plan.push({...refs[i],variant:'different_source_'+mode,mode,anchor:refs[(i+offset)%refs.length].reference,expected:false,labelType:'different_source_proxy_not_human_verified'});
for(const t of plan)t.taskId=t.variant+':'+t.auditId;
const fingerprintFiles=[resolve(source,'diagnostic-manifest.json'),resolve(source,'baseline-policies.json'),resolve(source,'results.jsonl'),resolve(source,'pricing.json'),...['run-coverage-experiment.mjs','coverage-experiment.mjs','benchmark-variants.mjs'].map(n=>new URL(n,import.meta.url))];
const fingerprints=fingerprintFiles.map(p=>({path:String(p),sha256:sha(readFileSync(p))}));
for(const dir of ['server','shared'])for(const name of readdirSync(resolve(runtime,dir)).filter(n=>n.endsWith('.js')).sort()) {
  const path=resolve(runtime,dir,name);fingerprints.push({path,sha256:sha(readFileSync(path))});
}
const assetPaths=[...new Set(plan.flatMap(t=>[t.file,t.reference,t.anchor].filter(Boolean)))].sort();
const assets=assetPaths.map(path=>({path,sha256:sha(readFileSync(path))}));
const config={version:'coverage-v3',model,maxAttempts,maxInputTokens,normalizationVersion:NORMALIZATION_HASH_VERSION,fingerprints,assets,plan,productionChanges:false,holdoutEvaluated:false,independentLabelsPending:true};
const configHash=sha(JSON.stringify(config));
mkdirSync(run,{recursive:true});
function atomic(name,value){const p=resolve(run,name),tmp=p+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));for(let n=0;;n++){try{renameSync(tmp,p);return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||n===99)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}}}
if(command==='--repair-local-signal-limit') {
  // Narrow recovery: retain all paid results and archive every local failure.
  // No external attempt for a failed case may exist, and no input may change.
  if(existsSync(resolve(run,'run.lock')))throw Error('live_writer_lock');
  const old=read(resolve(run,'config.json')),status=read(resolve(run,'status.json'));
  if(status.state!=='blocked')throw Error('repair_requires_blocked_run');
  const strip=({fingerprints,configHash,...rest})=>rest;
  if(JSON.stringify(strip(old))!==JSON.stringify(strip(config)))throw Error('repair_input_or_plan_changed');
  const tooling=new Set(['run-coverage-experiment.mjs','coverage-experiment.mjs','benchmark-variants.mjs']);
  for(let i=0;i<old.fingerprints.length;i++) {
    const before=old.fingerprints[i],after=fingerprints[i];
    if(before.path!==after?.path||before.sha256!==after.sha256&&!tooling.has(before.path.split('/').at(-1)))throw Error('repair_non_tooling_change');
  }
  const rows=lines(resolve(run,'results.jsonl')),events=lines(resolve(run,'attempts.jsonl')),failed=rows.filter(r=>r.error);
  if(!failed.length||failed.some(r=>r.error!=='content_supporting_limit'||events.some(e=>e.caseId===r.id)))throw Error('repair_requires_proven_local_only_failures');
  const history=resolve(run,'recovery-'+old.configHash.slice(0,12));mkdirSync(history,{recursive:false});
  writeFileSync(resolve(history,'config.json'),JSON.stringify(old,null,2));writeFileSync(resolve(history,'status.json'),JSON.stringify(status,null,2));writeFileSync(resolve(history,'results.jsonl'),readFileSync(resolve(run,'results.jsonl')));
  atomic('recovery.json',{previousConfigHash:old.configHash,configHash,failedCaseIds:failed.map(r=>r.id),preservedPaidResults:rows.length-failed.length,reason:'Local eight-signal schema cap; no external attempts for failed cases',history,at:new Date().toISOString()});
  writeFileSync(resolve(run,'results.jsonl'),rows.filter(r=>!r.error).map(r=>JSON.stringify(r)+'\n').join(''));
  atomic('config.json',{...config,configHash});console.log(JSON.stringify({repairedLocalFailures:failed.length,preservedPaidResults:rows.length-failed.length,configHash}));
} else if(existsSync(resolve(run,'config.json'))&&read(resolve(run,'config.json')).configHash!==configHash)throw Error('frozen_configuration_changed');
if(command==='--repair-local-signal-limit') {
  // Recovery is complete; explicit --run resumes the same identity and ledger.
} else if(command==='--prepare') {
  atomic('config.json',{...config,configHash});
  atomic('threshold-sweep.json',{source,sweeps:summarizeSweep(sourceRows,policies,gates),independentLabelsPending:true,candidateSelected:false,holdoutEvaluated:false});
  console.log(JSON.stringify({prepared:true,planned:plan.length,paidCases:plan.filter(t=>t.variant!=='exact_hash_control').length,variants:Object.fromEntries([...new Set(plan.map(t=>t.variant))].map(v=>[v,plan.filter(t=>t.variant===v).length])),configHash}));
} else if(command==='--analyze') {
  const rows=lines(resolve(run,'results.jsonl')),byId=new Map(rows.map(r=>[r.id,r]));
  const cascade=sourceRows.filter(r=>r.variant==='answerability_v2').map(r=>{
    const v=r.kind==='text'?'text_clarified':'image_observables_tiles';const second=byId.get(v+':'+r.auditId);
    return {...r,predicted:r.predicted??second?.predicted??null};
  });
  const report={state:read(resolve(run,'status.json')).state,configHash,independentLabelsPending:true,candidateSelected:false,productionChanges:false,holdoutEvaluated:false,
    cascade:Object.fromEntries(['text','content'].map(k=>[k,{before:summarizeDecisions(sourceRows.filter(r=>r.variant==='answerability_v2'&&r.kind===k)),after:summarizeDecisions(cascade.filter(r=>r.kind===k))}])),
    matching:[.5,.6,.7,.8,.9,.95].map(threshold=>({threshold,modes:Object.fromEntries(['exact','transformed','partial'].map(mode=>{
      const positive={exact:'resize_control',transformed:'crop_control',partial:'collage_control'}[mode];
      return [mode,{knownCopies:summarizeDecisions(rows.filter(r=>r.variant===positive).map(r=>({...r,predicted:r.answer?r.answer.probability>=threshold:r.predicted}))),differentSourceProxies:summarizeDecisions(rows.filter(r=>r.variant==='different_source_'+mode).map(r=>({...r,predicted:r.answer?r.answer.probability>=threshold:r.predicted})))}];
    }))})),
    exactHash:summarizeDecisions(rows.filter(r=>r.variant==='exact_hash_control')),
    cautions:['Source spam labels do not establish scam-policy truth.','Different-source pairs are proxy negatives; not independently reviewed hard negatives.','Second-pass selection uses this diagnostic run only; not unbiased validation.','No conversation history exists for text; none was fabricated.','Image tiles retain full-image evidence, but signal questions and additional views are a combined intervention.','Reported model scores are not calibrated confidence.']};
  atomic('coverage-report.json',report);console.log(JSON.stringify(report));
} else {
  if(!existsSync(resolve(run,'config.json')))throw Error('prepare_required');
  const key=process.env.TYPESAFE_EVAL_KEY;
  if(!key||process.env.ALLOW_PAID_BENCHMARK_EXPERIMENTS!=='true')throw Error('explicit_paid_experiment_authorization_required');
  const lockPath=resolve(run,'run.lock'),fd=openSync(lockPath,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,runId:'coverage-v3'}));closeSync(fd);
  process.on('exit',()=>{if(existsSync(lockPath))unlinkSync(lockPath);});
  let stop=false;process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
  function durable(name,row){const fd=openSync(resolve(run,name),'a');try{appendFileSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
  const rows=lines(resolve(run,'results.jsonl')),events=lines(resolve(run,'attempts.jsonl')),done=new Set(rows.map(r=>r.id));
  const settled=new Set(events.filter(e=>e.event==='completed').map(e=>e.id));
  if(events.some(e=>e.event==='reserved'&&(!settled.has(e.id)||!done.has(e.caseId))))throw Error('unreconciled_external_attempt_or_case_result');
  let attempts=events.filter(e=>e.event==='reserved').length,tokens=events.filter(e=>e.event==='completed').reduce((n,e)=>n+(e.inputTokens??0),0),unknown=events.filter(e=>e.event==='completed'&&e.inputTokens==null).length;
  let cost=events.filter(e=>e.event==='completed').reduce((n,e)=>n+BigInt(e.costMicros??0),0n),current=null,failure=null,consecutiveErrors=0;
  const status=state=>atomic('status.json',{state,pid:process.pid,updatedAt:new Date().toISOString(),completed:rows.length,planned:plan.length,attempts,maxAttempts,tokens,maxInputTokens,unknownUsage:unknown,estimatedUSD:money(cost.toString()),current,failure,configHash,productionChanges:false,holdoutEvaluated:false});
  const callbacks=task=>({onAttempt:async info=>{if(!info||attempts>=maxAttempts||tokens>=maxInputTokens||stop)throw Error('experiment_budget_exhausted');attempts++;durable('attempts.jsonl',{event:'reserved',caseId:task.taskId,pricing:price,...info});},onDispatch:async id=>durable('attempts.jsonl',{event:'dispatching',caseId:task.taskId,id}),onComplete:async(id,c)=>{const amount=estimate(c.inputTokens,rate);durable('attempts.jsonl',{event:'completed',caseId:task.taskId,id,...c,costMicros:amount});tokens+=c.inputTokens??0;unknown+=c.inputTokens==null?1:0;cost+=BigInt(amount??0);}});
  const client=new JevClient();
  try {
    status('running');
    for(const task of plan) {
      if(done.has(task.taskId))continue;
      if(stop||existsSync(resolve(run,'STOP'))||attempts>=maxAttempts||tokens>=maxInputTokens){status('stopped_at_limit_or_request');break;}
      current=task.taskId;status('running');
      let row={id:task.taskId,auditId:task.auditId,kind:task.kind,variant:task.variant,expected:task.expected,labelType:task.labelType,configHash,predicted:null};
      try {
        const options={key,model,mode:'partial',...callbacks(task)};
        if(task.kind==='text') {
          // Explicitly clarify existing evidence; no invented surrounding conversation.
          const transport=experimentTransport(clarifiedTransport(clarifyText));
          const answer=await new JevClient(transport).analyzeText(task.text,policies.textPolicy,options);
          const gate=evidenceDecision(answer,policies.textPolicy,'text',textEligibility);
          row={...row,answer,gate,predicted:gate.status==='insufficient_evidence'?null:gate.eligible};
        } else if(task.kind==='content') {
          const raw=readFileSync(task.file),full=await normalize(raw),oriented=await sharp(raw).rotate().toBuffer();
          const meta=await sharp(oriented).metadata(),tiles=[];
          for(const [x,y] of [[0,0],[1,0],[0,1],[1,1]]) {
            const left=Math.floor(meta.width*x/2),top=Math.floor(meta.height*y/2),width=Math.floor(meta.width*(x+1)/2)-left,height=Math.floor(meta.height*(y+1)/2)-top;
            if(width&&height)tiles.push((await normalize(await sharp(oriented).extract({left,top,width,height}).toBuffer())).bytes);
          }
          const transport=experimentTransport(async(url,init)=>{
            const body=init.body,request=JSON.parse(await body.get('request').text());
            request.state.detailViews=[];
            for(let i=0;i<tiles.length;i++){const id=randomUUID(),part='detail_'+i;request.state.detailViews.push(id);request.assets[id]={type:'image',part};body.append(part,new Blob([tiles[i]],{type:'image/jpeg'}),part+'.jpg');}
            request.questions.primary.instructions.question+=' Require both a visible solicitation and observable misleading claims under the trusted policy. Additional detail views are crops of the original, not independent evidence. Preserve framing and attribution from the full original; missing crop context cannot establish wrongdoing.';
            body.set('request',new Blob([JSON.stringify(request)],{type:'application/json'}));return fetch(url,{...init,body});
          });
          const definition=observablePolicy(policies.contentPolicy),answer=await new JevClient(transport).analyze(full.bytes,definition,undefined,options);
          let gate=evidenceDecision(answer,definition,'content',contentEligibility);
          if(gate.eligible&&(answer.signals.solicitation_visible<.9||answer.signals.misleading_claim_visible<.9))gate={eligible:false,status:'insufficient_evidence',blockedReasons:['observable_elements_not_established']};
          row={...row,answer,gate,predicted:gate.status==='insufficient_evidence'?null:gate.eligible,fullImageSha256:full.sha256,tileSha256:tiles.map(sha)};
        } else {
          const raw=readFileSync(task.reference),ref=await normalize(raw);let bytes,mode=task.mode??'partial';
          if(task.variant==='exact_hash_control')bytes=ref.bytes;
          else if(task.variant.startsWith('different_source_'))bytes=(await normalize(readFileSync(task.anchor))).bytes;
          else if(task.variant==='resize_control'){bytes=(await normalize(await sharp(raw).rotate().resize(384,384,{fit:'inside'}).jpeg({quality:65}).toBuffer())).bytes;mode='exact';}
          else if(task.variant==='crop_control'){const base=await sharp(raw).rotate().toBuffer(),m=await sharp(base).metadata(),x=Math.max(1,Math.floor(m.width*.03)),y=Math.max(1,Math.floor(m.height*.03));bytes=(await normalize(await sharp(base).extract({left:x,top:y,width:m.width-2*x,height:m.height-2*y}).jpeg({quality:90}).toBuffer())).bytes;mode='transformed';}
          else {mode='partial';const other=await normalize(readFileSync(task.anchor));bytes=(await normalize(await sharp({create:{width:1536,height:1536,channels:3,background:'#ffffff'}}).composite([{input:ref.bytes,left:0,top:0},{input:other.bytes,left:768,top:768}]).jpeg({quality:90}).toBuffer())).bytes;}
          const sampleSha256=sha(bytes);
          if(task.variant.startsWith('different_source_')&&sampleSha256===ref.sha256)throw Error('negative_proxy_identical_hash');
          if(sampleSha256===ref.sha256)row={...row,predicted:true,provenance:'exact_hash',probability:null,model:null,verified:false,providerCalls:0,sampleSha256,referenceSha256:ref.sha256};
          else {const answer=await client.compare(bytes,ref.bytes,{...options,mode});row={...row,answer,predicted:answer.probability>=.9,mode,provenance:'jev',sampleSha256,referenceSha256:ref.sha256};}
        }
      } catch(error) {row.error=safeError(error);if(['jev_authentication_failed','jev_rate_limit_deferred'].includes(row.error))throw error;}
      durable('results.jsonl',row);rows.push(row);done.add(task.taskId);current=null;status('running');
      consecutiveErrors=row.error?consecutiveErrors+1:0;if(consecutiveErrors>=5)throw Error('five_consecutive_experiment_failures');
      await new Promise(r=>setTimeout(r,1000));
    }
    if(done.size===plan.length)status('completed');
  } catch(error) {failure=safeError(error);status('blocked');process.exitCode=1;console.error(JSON.stringify({failure,current}));}
  finally {if(existsSync(lockPath))unlinkSync(lockPath);}
}
