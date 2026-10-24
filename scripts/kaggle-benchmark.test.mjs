import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('benchmark persists decisions and usage, excludes source text, and resumes without paid duplicates', () => {
  const root=mkdtempSync('G:/datasets-deleteme/typecheck/runner-test-');
  const runtime=resolve(root,'runs/test/runtime');
  mkdirSync(resolve(runtime,'server'),{recursive:true});mkdirSync(resolve(runtime,'shared'));
  writeFileSync(resolve(runtime,'package.json'),JSON.stringify({type:'module'}));
  const modules={
    'server/jev.js':`export class JevClient {async analyzeText(text,d,o){await o.onAttempt({id:'attempt-'+text,retry:0,startedAt:new Date().toISOString()});await o.onComplete('attempt-'+text,{outcome:'success',inputTokens:1000000,error:null});return {probability:text==='secret-positive'?.99:.01};}}`,
    'server/images.js':`export const NORMALIZATION_HASH_VERSION='test';export const normalize=()=>{};`,
    'server/text.js':`export const textDigest=()=> 'digest';export const textEligibility=(r,d,t)=>({status:'detected',eligible:r.probability>=t});`,
    'shared/text.js':`export const textBoundary=x=>x==='over-limit'?'text_over_limit':null;`,
    'server/content.js':`export const contentEligibility=()=>{};`,
    'shared/content.js':`export const CONTENT_PRESETS=[{id:'scams',definition:{test:true}}];`,
    'server/security.js':`export const safeError=()=> 'test_error';`,
  };
  for(const [path,code] of Object.entries(modules)) writeFileSync(resolve(runtime,path),code);
  writeFileSync(resolve(root,'text-manifest.json'),JSON.stringify([
    {id:'positive',kind:'text',text:'secret-positive',expected:true},
    {id:'negative',kind:'text',text:'secret-negative',expected:false},
    {id:'over-limit',kind:'text',text:'over-limit',expected:true},
  ]));
  writeFileSync(resolve(root,'preparation.json'),'{}');
  writeFileSync(resolve(root,'runs/test/pricing.json'),JSON.stringify({model:'jev-1.14.0',currency:'USD',perMillion:'0.042',source:'https://typesafe.ai/'}));
  const env={...process.env,BENCHMARK_ROOT:root,BENCHMARK_RUN_ID:'test',TYPESAFE_EVAL_KEY:'fake-offline-key',ALLOW_PAID_KAGGLE_EVALUATION:'true'};
  const invoke=()=>spawnSync(process.execPath,[resolve('scripts/kaggle-benchmark.mjs')],{env,encoding:'utf8',timeout:20000});
  let child=invoke();assert.equal(child.status,0,child.stderr);
  const status=JSON.parse(readFileSync(resolve(root,'runs/test/status.json')));
  assert.equal(status.state,'completed');assert.equal(status.attempts,2);assert.equal(status.inputTokens,2000000);
  assert.equal(status.cost.estimatedAmount,'0.084000');assert.equal(status.cost.costMicros,'84000');
  assert.equal(status.cost.pricedAttempts,2);assert.equal(status.cost.partial,false);
  assert.equal(status.metrics.text.tp,1);assert.equal(status.metrics.text.tn,1);assert.equal(status.metrics.text.abstained,1);
  const receipts=readFileSync(resolve(root,'runs/test/results.jsonl'),'utf8');
  assert.ok(!receipts.includes('secret-positive'));assert.ok(!receipts.includes('secret-negative'));
  child=invoke();assert.equal(child.status,0,child.stderr);
  assert.equal(readFileSync(resolve(root,'runs/test/results.jsonl'),'utf8'),receipts);
  assert.equal(JSON.parse(readFileSync(resolve(root,'runs/test/status.json'))).cost.estimatedAmount,'0.084000');
  // Earlier receipts had no pricing: derive estimates without rewriting them.
  const attemptPath=resolve(root,'runs/test/attempts.jsonl');
  const oldEvents=readFileSync(attemptPath,'utf8').trim().split('\n').map(line=>{
    const event=JSON.parse(line);delete event.pricing;delete event.costMicros;return event;
  });
  writeFileSync(attemptPath,oldEvents.map(event=>JSON.stringify(event)).join('\n')+'\n');
  child=invoke();assert.equal(child.status,0,child.stderr);
  const backfilled=JSON.parse(readFileSync(resolve(root,'runs/test/status.json'))).cost;
  assert.equal(backfilled.estimatedAmount,'0.084000');assert.equal(backfilled.retrospectivelyPricedAttempts,2);
  // An uncompleted external attempt must block automatic retries after a crash.
  writeFileSync(resolve(root,'runs/test/attempts.jsonl'),JSON.stringify({event:'reserved',id:'unresolved'})+'\n',{flag:'a'});
  child=invoke();assert.notEqual(child.status,0);assert.match(child.stderr,/unreconciled_provider_attempt/);
});
