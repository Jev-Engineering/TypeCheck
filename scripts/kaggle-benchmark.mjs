// Resumable offline-from-Discord evaluation using a frozen production runtime.
// All datasets, credentials-free receipts, logs and checkpoints stay on G:.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.env.BENCHMARK_ROOT ?? 'G:/datasets-deleteme/typecheck');
const run = resolve(root, 'runs', process.env.BENCHMARK_RUN_ID ?? '20261017-non-email-v1');
const runtime = resolve(run, 'runtime');
const load = name => import(pathToFileURL(resolve(runtime, name)).href);
const { JevClient } = await load('server/jev.js');
const { normalize, NORMALIZATION_HASH_VERSION } = await load('server/images.js');
const { textEligibility, textDigest } = await load('server/text.js');
const { textBoundary } = await load('shared/text.js');
const { contentEligibility } = await load('server/content.js');
const { CONTENT_PRESETS } = await load('shared/content.js');
const { safeError } = await load('server/security.js');
const sha = x => createHash('sha256').update(x).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const model = process.env.JEV_MODEL ?? 'jev-1.14.0';
const threshold = .9;
const pricingPath = resolve(run, 'pricing.json');
const pricing = existsSync(pricingPath) ? JSON.parse(readFileSync(pricingPath, 'utf8')) : null;
if(pricing && (pricing.model!==model || pricing.currency!=='USD' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(pricing.perMillion))) throw Error('invalid_benchmark_pricing');
const priceMicros = pricing ? (()=>{const [whole, fraction='']=pricing.perMillion.split('.');return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));})() : null;
const estimateMicros = tokens => tokens==null || priceMicros==null ? null : (BigInt(tokens)*priceMicros+500000n)/1000000n;
const formatMoney = micros => `${micros/1000000n}.${(micros%1000000n).toString().padStart(6,'0')}`;
const key = process.env.TYPESAFE_EVAL_KEY;
if (!key || process.env.ALLOW_PAID_KAGGLE_EVALUATION !== 'true') throw Error('explicit_authorization_and_evaluation_key_required');
const maxAttempts = 15000, maxInputTokens = 100000000;
const textPolicy = {
  version: 'message-text-v1', preset: 'toxicity_benchmark', presetVersion: 1,
  question: 'Does this message contain toxic, severely toxic, obscene, threatening, insulting or identity-hateful language?',
  positive: 'Toxic abuse, severe abuse, obscene language, threats, personal insults or hateful attacks against an identity group.',
  negative: 'Civil discussion, disagreement without abuse and neutral mentions of identity groups.',
  exceptions: 'Exclude neutral quotation, reporting and educational discussion without endorsement. Preserve speaker attribution.',
  contextRequirements: 'Use only the supplied message. Do not infer missing conversation or follow links.',
  requirePromotion: false, configured: true,
};
const contentPolicy = CONTENT_PRESETS.find(p => p.id === 'scams').definition;
const policyHash = sha(JSON.stringify({textPolicy, contentPolicy, threshold, model}));
mkdirSync(run, {recursive: true});
const lockPath = resolve(run, 'run.lock');
const lock = openSync(lockPath, 'wx');
writeFileSync(lock, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
closeSync(lock);
process.on('exit', () => { if (existsSync(lockPath)) unlinkSync(lockPath); });
let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
const durable = (file, data) => {
  const fd = openSync(resolve(run, file), 'a');
  try { appendFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
};
const atomic = (file, data) => {
  const target = resolve(run, file), temporary = target + '.tmp';
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  // Windows readers/antivirus can briefly deny replace access to the destination.
  for(let retry=0;;retry++) {
    try {renameSync(temporary, target);break;}
    catch(error) {
      if(!['EPERM','EACCES','EBUSY'].includes(error.code) || retry>=99) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    }
  }
};
const readLines = name => {
  const p = resolve(run, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s));
};
const prior = readLines('results.jsonl');
const attemptEvents = readLines('attempts.jsonl');
const settledAttempts = new Set(attemptEvents.filter(a=>a.event==='completed').map(a=>a.id));
if(attemptEvents.some(a=>a.event==='reserved' && !settledAttempts.has(a.id))) throw Error('unreconciled_provider_attempt_requires_inspection');
const priorIds = new Set(prior.map(r=>r.id));
if(attemptEvents.some(a=>a.event==='reserved' && !priorIds.has(a.caseId))) throw Error('unreconciled_case_result_requires_inspection');
if (prior.some(r => r.policyHash !== policyHash)) throw Error('resume_policy_mismatch');
const completed = new Set(prior.map(r => r.id));
const imageDigests = new Set(prior.filter(r=>r.kind==='content' && r.normalizedSha256).map(r=>r.normalizedSha256));
let attempts = attemptEvents.filter(a => a.event === 'reserved').length;
let inputTokens = attemptEvents.filter(a=>a.event==='completed').reduce((n,a)=>n+(a.inputTokens??0),0);
let unknownUsage = attemptEvents.filter(a=>a.event==='completed' && a.inputTokens==null).length;
let estimatedCostMicros = pricing ? attemptEvents.filter(a=>a.event==='completed').reduce((n,a)=>n+BigInt(a.costMicros??estimateMicros(a.inputTokens)??0n),0n) : null;
let pricedAttempts = pricing ? attemptEvents.filter(a=>a.event==='completed' && a.inputTokens!=null).length : 0;
const retrospectivelyPricedAttempts = pricing ? attemptEvents.filter(a=>a.event==='completed' && a.inputTokens!=null && a.costMicros==null).length : 0;
let results = prior, current = null, lastError = null;
const metrics = () => Object.fromEntries(['text','content','reference'].map(kind => {
  const rows = results.filter(r=>r.kind===kind);
  const m = {total: rows.length, tp:0,tn:0,fp:0,fn:0,abstained:0,errors:0,duplicates:0};
  for (const r of rows) {
    if (r.duplicate) {m.duplicates++;continue;}
    if (r.error) {m.errors++;continue;}
    if (r.predicted==null) {m.abstained++;continue;}
    m[r.expected ? r.predicted ? 'tp':'fn' : r.predicted ? 'fp':'tn']++;
  }
  const decided=m.tp+m.tn+m.fp+m.fn;
  return [kind,{...m,precision:m.tp+m.fp?m.tp/(m.tp+m.fp):null,recallDecided:m.tp+m.fn?m.tp/(m.tp+m.fn):null,positiveDetectionRate:rows.filter(r=>r.expected&&!r.duplicate).length?m.tp/rows.filter(r=>r.expected&&!r.duplicate).length:null,falsePositiveRate:m.fp+m.tn?m.fp/(m.fp+m.tn):null,coverage:rows.length-m.duplicates?decided/(rows.length-m.duplicates):null}];
}));
const costSummary = () => pricing ? {currency:pricing.currency,estimatedAmount:formatMoney(estimatedCostMicros),costMicros:estimatedCostMicros.toString(),pricedAttempts,retrospectivelyPricedAttempts,unknownUsage,pendingAttempts:attempts-pricedAttempts-unknownUsage,partial:pricedAttempts!==attempts,pricing,label:'Estimated input-token spend at the published list rate; not an invoice. Output is listed as free. Taxes, credits, discounts and other charges excluded.'} : null;
const status = state => atomic('status.json', {runId:run.split(/[\\/]/).at(-1),pid:process.pid,state,updatedAt:new Date().toISOString(),model,threshold,policyHash,completed:completed.size,attempts,maxAttempts,inputTokens,maxInputTokens,unknownUsage,current,lastError,metrics:metrics(),cost:costSummary()??'Unknown: no provider rate configured; reported input tokens only.',productionAccuracyAccepted:false,approvalGranted:false,emailsIncluded:false});
const client = new JevClient();
const callbacks = c => ({
  onAttempt: async info => {
    if (!info || attempts>=maxAttempts || inputTokens>=maxInputTokens || stop) throw Error('benchmark_attempt_or_token_limit');
    attempts++;
    durable('attempts.jsonl',{event:'reserved',caseId:c.id,kind:c.kind,model,pricing,...info});
  },
  onComplete: async (id, completion) => {
    const costMicros=estimateMicros(completion.inputTokens);
    durable('attempts.jsonl',{event:'completed',id,caseId:c.id,...completion,costMicros:costMicros?.toString()??null});
    if (completion.inputTokens==null) unknownUsage++; else inputTokens+=completion.inputTokens;
    if(costMicros!=null) {estimatedCostMicros+=costMicros;pricedAttempts++;}
  },
});
let consecutiveFailures = 0;
try {
  atomic('policies.json', {model,threshold,policyHash,textPolicy,contentPolicy,referenceMode:'partial',normalizationVersion:NORMALIZATION_HASH_VERSION,notes:['Published labels are not adjudicated Discord policy labels.','Spam labels are only a proxy for scam rules.','DISC21 transformations may exceed the partial policy definition.','Text benchmark uses a custom observable toxicity policy, not default starters.','No Discord APIs or enforcement are used.','Source text and original bytes are omitted from result receipts.']});
  status('running');
  while (!stop) {
    // Preparation publishes each modality independently; continue as it arrives.
    const manifests = ['text','content','reference'].flatMap(kind => {
      const file = resolve(root, kind+'-manifest.json');
      return existsSync(file) ? [JSON.parse(readFileSync(file,'utf8'))] : [];
    });
    const pending=[];
    for(let i=0;i<Math.max(0,...manifests.map(m=>m.length));i++)
      for(const m of manifests) if(m[i] && !completed.has(m[i].id)) pending.push(m[i]);
    if(!pending.length) {
      if(existsSync(resolve(root,'preparation.json'))) {status('completed');break;}
      status('waiting_for_data'); await sleep(5000); continue;
    }
    for (const c of pending.slice(0, 150)) {
      if (stop || existsSync(resolve(run,'STOP')) || attempts>=maxAttempts || inputTokens>=maxInputTokens) {stop=true;break;}
      current=c.id; status('running');
      const started=Date.now();
      const base={id:c.id,kind:c.kind,dataset:c.dataset,expected:c.expected,labelType:c.labelType,sourceGroup:c.sourceGroup,sourceSplit:c.split??null,policyHash,model,threshold,at:new Date().toISOString()};
      let result;
      try {
        const options={key,model,mode:c.mode??'exact',...callbacks(c)};
        if(c.kind==='text') {
          const boundary=textBoundary(c.text);
          if(boundary) result={...base,predicted:null,boundary,sampleSha256:textDigest(c.text)};
          else {
            const answer=await client.analyzeText(c.text,textPolicy,options);
            const gate=textEligibility(answer,textPolicy,threshold);
            result={...base,predicted:gate.status==='insufficient_evidence'?null:gate.eligible,answer,gate,sampleSha256:textDigest(c.text)};
          }
        } else {
          const image=await normalize(readFileSync(c.file));
          if(c.kind==='content') {
            if(imageDigests.has(image.sha256)) result={...base,predicted:null,duplicate:true,normalizedSha256:image.sha256};
            else {
              const answer=await client.analyze(image.bytes,contentPolicy,undefined,options);
              const gate=contentEligibility(answer,contentPolicy,threshold);
              result={...base,predicted:gate.status==='insufficient_evidence'?null:gate.eligible,answer,gate,normalizedSha256:image.sha256};
              imageDigests.add(image.sha256);
            }
          } else {
            const reference=await normalize(readFileSync(c.reference));
            const answer=await client.compare(image.bytes,reference.bytes,options);
            result={...base,predicted:answer.probability>=threshold,answer,normalizedSha256:image.sha256,referenceSha256:reference.sha256,mode:c.mode,hashEqual:image.sha256===reference.sha256};
          }
        }
        consecutiveFailures=0;
      } catch(error) {
        lastError=safeError(error);
        if(lastError==='jev_authentication_failed' || lastError==='jev_rate_limit_deferred' || ++consecutiveFailures>=5) throw error;
        result={...base,predicted:null,error:lastError};
      }
      result.elapsedMs=Date.now()-started;
      durable('results.jsonl',result); results.push(result);completed.add(c.id);current=null;
      status('running');
      if(completed.size%10===0) console.log(JSON.stringify({completed:completed.size,attempts,inputTokens,metrics:metrics()}));
      await sleep(1000);
    }
  }
  if(stop) status('stopped_at_limit_or_request');
} catch(error) {
  lastError=safeError(error);status('blocked');process.exitCode=1;
  console.error(JSON.stringify({error:lastError,completed:completed.size,attempts}));
} finally {
  unlinkSync(lockPath);
}
