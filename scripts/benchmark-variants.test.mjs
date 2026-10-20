import test from 'node:test';
import assert from 'node:assert/strict';
import {rewriteQuestions, experimentTransport, evidenceDecision, summarizeDecisions, wilson} from './benchmark-variants.mjs';

test('answerability question includes negatives and retains trusted primary policy', () => {
  const request={state:{message:'untrusted'},questions:{sufficient:{instructions:{question:'old',trustedPolicy:{trust:'untrusted evidence'}}},context:{instructions:{question:'old'}},primary:{type:'noul',instructions:'frozen primary'}}};
  const changed=rewriteQuestions(request);
  assert.match(changed.questions.sufficient.instructions.question,/EITHER/);
  assert.deepEqual(changed.questions.primary,request.questions.primary);
  assert.equal(changed.questions.sufficient.instructions.trustedPolicy.trust,'untrusted evidence');
  assert.equal(request.questions.sufficient.instructions.question,'old');
});

test('multipart experiment retains original asset bytes and their references',async()=>{
  const request={state:{submitted:'uuid'},assets:{uuid:{type:'image',part:'submitted'}},questions:{readability:{instructions:{}},context:{instructions:{}},primary:{type:'noul'}}};
  const form=new FormData();form.append('request',new Blob([JSON.stringify(request)]));form.append('submitted',new Blob(['image-bytes'],{type:'image/jpeg'}),'image.jpg');
  await experimentTransport(async(url,init)=>{
    const changed=JSON.parse(await init.body.get('request').text());
    assert.deepEqual(changed.assets,request.assets);assert.deepEqual(changed.state,request.state);
    assert.equal(await init.body.get('submitted').text(),'image-bytes');return new Response('{}');
  })('https://example.test',{body:form});
});

const gate=(a,d,t)=>({eligible:a.probability>=t&&a.promotionProbability>=t&&a.context==='solicitation',status:'insufficient_evidence',blockedReasons:['promotion_required']});
test('clear negatives need answerable input, while positives retain every promotion gate',()=>{
  const answer={probability:.01,sufficientProbability:.99,promotionProbability:0,context:'other',readability:'readable'};
  assert.equal(evidenceDecision(answer,{requireReadableText:true},'text',gate).status,'not_detected');
  assert.equal(evidenceDecision({...answer,sufficientProbability:.1},{},'text',gate).status,'insufficient_evidence');
  assert.equal(evidenceDecision({...answer,readability:'partially_readable'},{requireReadableText:true},'content',gate).status,'insufficient_evidence');
  for(const kind of ['text','content']) for(const probability of [.1,.5,.89,.9,1])
    for(const promotionProbability of [0,.89,.9,1]) for(const context of ['other','warning','solicitation','insufficient_context']) {
      const a={...answer,probability,promotionProbability,context};
      const candidate=evidenceDecision(a,{},kind,gate);
      if(candidate.eligible) assert.equal(gate(a,{},.9).eligible,true);
    }
});

test('metrics count unlabeled cases and abstentions without optimistic decided-only recall',()=>{
  const m=summarizeDecisions([{expected:true,predicted:true},{expected:true,predicted:null},{expected:false,predicted:false},{expected:null,predicted:true}]);
  assert.equal(m.positiveDetectionRate,.5);assert.equal(m.coverage,.75);assert.equal(m.unlabeled,1);
  assert.ok(wilson(0,300).high>0);assert.equal(wilson(0,0),null);
});
