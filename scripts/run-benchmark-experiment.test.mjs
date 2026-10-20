import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const sha=x=>createHash('sha256').update(x).digest('hex');

test('diagnostic runner resumes receipts, freezes policies and rejects protected holdout before dispatch',()=>{
  const parent=process.platform==='win32'&&existsSync('G:/datasets-deleteme/typecheck')?'G:/datasets-deleteme/typecheck':tmpdir();
  const root=mkdtempSync(resolve(parent,'experiment-test-')),run=resolve(root,'experiments/evidence-v2'),runtime=resolve(run,'runtime');
  for(const dir of ['server','shared','node_modules/sharp'])mkdirSync(resolve(runtime,dir),{recursive:true});
  writeFileSync(resolve(runtime,'package.json'),' {"type":"module"}');
  const modules={
    'server/jev.js':`export class JevClient{async analyzeText(text,d,o){await o.onAttempt({id:'one-attempt',retry:0,startedAt:'2026-10-17T00:00:00.000Z'});await o.onDispatch('one-attempt');await o.onComplete('one-attempt',{inputTokens:100,outcome:'success',error:null});return{probability:.01,sufficientProbability:.99,promotionProbability:0,context:'other',inputTokens:100};}}`,
    'server/images.js':`export const normalize=()=>{};export const NORMALIZATION_HASH_VERSION='test';`,
    'server/text.js':`export const textDigest=()=> 'digest';export const textEligibility=()=>({eligible:false,status:'not_detected'});`,
    'shared/text.js':`export const textBoundary=()=>null;`,
    'server/content.js':`export const contentEligibility=()=>({eligible:false,status:'not_detected'});`,
    'shared/analytics.js':`export const parseRate=r=>r;export const estimate=()=> '4';export const money=n=>(Number(n)/1000000).toFixed(6);`,
    'server/security.js':`export const safeError=()=> 'test_error';`,
    'node_modules/sharp/package.json':`{"main":"index.cjs"}`,
    'node_modules/sharp/index.cjs':`module.exports=function(){throw Error('image processing not expected');};`,
  };
  for(const [name,body]of Object.entries(modules))writeFileSync(resolve(runtime,name),body);
  let cases=[{id:'source',auditId:'audit-0001',kind:'text',text:'source text never retained in receipts',expected:false,sourceGroup:'digest',split:'diagnostic_tuning_only'}];
  const save=()=>{const bytes=JSON.stringify(cases);writeFileSync(resolve(run,'diagnostic-manifest.json'),bytes);writeFileSync(resolve(run,'freeze.json'),JSON.stringify({diagnosticSha256:sha(bytes)}));};save();
  writeFileSync(resolve(run,'baseline-policies.json'),JSON.stringify({textPolicy:{configured:true},contentPolicy:{}}));
  writeFileSync(resolve(run,'pricing.json'),JSON.stringify({currency:'USD',perMillion:'0.042',effectiveAt:'2026-10-17T00:00:00.000Z'}));
  const env={...process.env,BENCHMARK_ROOT:root,TYPESAFE_EVAL_KEY:'offline-fake-key',ALLOW_PAID_BENCHMARK_EXPERIMENTS:'true'};
  const invoke=()=>spawnSync(process.execPath,[resolve('scripts/run-benchmark-experiment.mjs')],{env,encoding:'utf8',timeout:15000});
  let child=invoke();assert.equal(child.status,0,child.stderr);
  const status=JSON.parse(readFileSync(resolve(run,'status.json')));assert.equal(status.state,'completed');assert.equal(status.attempts,1);assert.equal(status.estimatedUSD,'0.000004');
  const receipts=readFileSync(resolve(run,'results.jsonl'),'utf8');assert.ok(!receipts.includes(cases[0].text));
  child=invoke();assert.equal(child.status,0,child.stderr);assert.equal(readFileSync(resolve(run,'results.jsonl'),'utf8'),receipts);
  writeFileSync(resolve(run,'baseline-policies.json'),JSON.stringify({textPolicy:{configured:false},contentPolicy:{}}));
  child=invoke();assert.notEqual(child.status,0);assert.match(child.stderr,/configuration_changed/);
  cases=[{...cases[0],split:'reserved_blind_holdout'}];save();
  child=invoke();assert.notEqual(child.status,0);assert.match(child.stderr,/protected_holdout/);
  assert.equal(readFileSync(resolve(run,'results.jsonl'),'utf8'),receipts);
});
