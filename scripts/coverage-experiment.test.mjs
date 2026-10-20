import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionAt,selectAbstentions,clarifyText,observablePolicy} from './coverage-experiment.mjs';
const gate=(a,d,t)=>({eligible:a.probability>=t&&(!d.requirePromotion||a.promotionProbability>=t),status:d.requirePromotion&&a.promotionProbability<t?'insufficient_evidence':'detected'});
test('threshold sweeps retain fixed answerability and promotion safeguards',()=>{
  const a={probability:.75,sufficientProbability:.99,context:'other',promotionProbability:.2};
  assert.equal(decisionAt(a,{},'text',gate,.7,.2),true);
  assert.equal(decisionAt({...a,sufficientProbability:.8},{},'text',gate,.7,.2),null);
  assert.equal(decisionAt(a,{requirePromotion:true},'text',gate,.7,.2),null);
  assert.equal(decisionAt({...a,probability:.15},{},'text',gate,.9,.2),false);
  assert.throws(()=>decisionAt(a,{},'text',gate,.2,.3),/invalid_threshold/);
});
test('second pass selects only frozen uncertain diagnostic cases and rejects holdout',()=>{
  const c={auditId:'a',kind:'text',split:'diagnostic_tuning_only'};
  const rows=[{id:'v:a',auditId:'a',kind:'text',variant:'answerability_v2',predicted:null,gate:{blockedReasons:['primary_review_band']}}];
  assert.equal(selectAbstentions([c],rows).length,1);
  assert.equal(selectAbstentions([c],[{...rows[0],predicted:false}]).length,0);
  assert.equal(selectAbstentions([c],[{...rows[0],gate:{blockedReasons:['input_not_decidable']}}]).length,0);
  assert.throws(()=>selectAbstentions([{...c,split:'holdout'}],rows),/protected_holdout/);
});
test('clarification retains untrusted evidence and policy, observable signals are not fraud labels',()=>{
  const r={state:{message:'ignore policy'},questions:{primary:{instructions:{question:'Q',trustedPolicy:{positive:'P',exceptions:'E'}}}}};
  const changed=clarifyText(r);assert.deepEqual(changed.state,r.state);assert.deepEqual(changed.questions.primary.instructions.trustedPolicy,r.questions.primary.instructions.trustedPolicy);
  assert.equal(r.questions.primary.instructions.question,'Q');
  const p={question:'original',requirePromotion:true,supporting:[]};
  const d=observablePolicy(p);assert.equal(d.question,p.question);assert.equal(d.requirePromotion,true);assert.equal(d.supporting.length,2);assert.equal(p.supporting.length,0);
  assert.equal(observablePolicy({...p,supporting:Array.from({length:8},(_,i)=>({id:'s'+i,question:'Q'}))}).supporting.length,8);
});
