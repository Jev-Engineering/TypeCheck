import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('coverage runner freezes inputs, accounts once, resumes without rebilling and rejects holdout',()=>{
  const parent=process.platform==='win32'&&existsSync('G:/datasets-deleteme/typecheck')?'G:/datasets-deleteme/typecheck':tmpdir();
  const root=mkdtempSync(resolve(parent,'coverage-test-')),source=resolve(root,'repeats/20261017-repeat-01/experiments/evidence-v2'),runtime=resolve(source,'runtime'),run=resolve(root,'experiments/coverage-v3');
  for(const dir of ['server','shared','node_modules/sharp'])mkdirSync(resolve(runtime,dir),{recursive:true});
  writeFileSync(resolve(runtime,'package.json'),'{"type":"module"}');
  const modules={
    'server/jev.js':`export class JevClient{async analyzeText(text,d,o){await o.onAttempt({id:'one',retry:0});await o.onDispatch('one');await o.onComplete('one',{inputTokens:100,outcome:'success',error:null});return{probability:.01,sufficientProbability:.99,context:'other',inputTokens:100};}}`,
    'server/images.js':`export const normalize=()=>{};export const NORMALIZATION_HASH_VERSION='test';`,
    'server/text.js':`export const textEligibility=()=>({eligible:false,status:'not_detected'});`,
    'server/content.js':`export const contentEligibility=()=>({eligible:false,status:'not_detected'});`,
    'shared/analytics.js':`export const parseRate=r=>r;export const estimate=()=> '4';export const money=n=>(Number(n)/1000000).toFixed(6);`,
    'server/security.js':`export const safeError=()=> 'offline_error';`,
    'node_modules/sharp/package.json':`{"main":"index.cjs"}`,
    'node_modules/sharp/index.cjs':`module.exports=function(){throw Error('not expected');};`,
  };
  for(const [name,body]of Object.entries(modules))writeFileSync(resolve(runtime,name),body);
  const c={auditId:'a',kind:'text',text:'untrusted private source',expected:false,split:'diagnostic_tuning_only'};
  const save=cases=>{const bytes=JSON.stringify(cases);writeFileSync(resolve(source,'diagnostic-manifest.json'),bytes);writeFileSync(resolve(source,'freeze.json'),JSON.stringify({diagnosticSha256:sha(bytes)}));};save([c]);
  writeFileSync(resolve(source,'status.json'),'{"state":"completed"}');
  writeFileSync(resolve(source,'results.jsonl'),JSON.stringify({id:'answerability_v2:a',auditId:'a',kind:'text',variant:'answerability_v2',predicted:null,expected:false,gate:{blockedReasons:['primary_review_band']},answer:{probability:.5,sufficientProbability:.99,context:'other'}})+'\n');
  writeFileSync(resolve(source,'baseline-policies.json'),JSON.stringify({textPolicy:{configured:true},contentPolicy:{}}));
  writeFileSync(resolve(source,'pricing.json'),JSON.stringify({currency:'USD',perMillion:'0.042',effectiveAt:'2026-10-17T00:00:00.000Z'}));
  const env={...process.env,BENCHMARK_ROOT:root,TYPESAFE_EVAL_KEY:'offline-key',ALLOW_PAID_BENCHMARK_EXPERIMENTS:'true'};
  const invoke=command=>spawnSync(process.execPath,[resolve('scripts/run-coverage-experiment.mjs'),command],{env,encoding:'utf8',timeout:15000});
  for(const command of ['--prepare','--run','--analyze']){const p=invoke(command);assert.equal(p.status,0,p.stderr);}
  const receipts=readFileSync(resolve(run,'results.jsonl'),'utf8');assert.ok(!receipts.includes(c.text));
  let status=JSON.parse(readFileSync(resolve(run,'status.json')));assert.equal(status.state,'completed');assert.equal(status.attempts,1);assert.equal(status.estimatedUSD,'0.000004');
  const report=JSON.parse(readFileSync(resolve(run,'coverage-report.json')));assert.equal(report.cascade.text.after.coverage,1);assert.equal(report.independentLabelsPending,true);assert.equal(report.holdoutEvaluated,false);
  assert.equal(invoke('--run').status,0);assert.equal(readFileSync(resolve(run,'results.jsonl'),'utf8'),receipts);
  // The narrow local repair must never erase a failure that has a paid attempt.
  writeFileSync(resolve(run,'status.json'),JSON.stringify({...status,state:'blocked'}));
  writeFileSync(resolve(run,'results.jsonl'),receipts+JSON.stringify({id:'text_clarified:a',error:'content_supporting_limit'})+'\n');
  let blockedRepair=invoke('--repair-local-signal-limit');assert.notEqual(blockedRepair.status,0);assert.match(blockedRepair.stderr,/proven_local_only/);
  writeFileSync(resolve(run,'results.jsonl'),receipts);writeFileSync(resolve(run,'status.json'),JSON.stringify(status));
  writeFileSync(resolve(source,'baseline-policies.json'),'{"textPolicy":{"configured":false}}');
  let child=invoke('--run');assert.notEqual(child.status,0);assert.match(child.stderr,/frozen_configuration_changed/);
  save([{...c,split:'reserved_blind_holdout'}]);child=invoke('--prepare');assert.notEqual(child.status,0);assert.match(child.stderr,/protected_holdout/);
});
