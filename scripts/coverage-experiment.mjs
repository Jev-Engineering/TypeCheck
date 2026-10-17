// Diagnostic experiments only. Never imported by the application.
import {evidenceDecision,summarizeDecisions} from './benchmark-variants.mjs';

export function decisionAt(answer,definition,kind,productionGate,positive=.9,negative=.1) {
  if (!(negative>=0 && negative<positive && positive<=1)) throw Error('invalid_threshold_pair');
  // Answerability and promotion safeguards stay fixed at .9 while primary cutoffs vary.
  const fixed=evidenceDecision({...answer,probability:answer.probability>=positive?1:answer.probability<=negative?0:.5},definition,kind,productionGate);
  return fixed.status==='insufficient_evidence'?null:fixed.eligible;
}

export function clarifiedTransport(rewrite,http=fetch) {
  return async(url,init)=>{
    if(typeof init.body==='string')return http(url,{...init,body:JSON.stringify(rewrite(JSON.parse(init.body)))});
    const body=new FormData();
    for(const [name,value] of init.body.entries())body.append(name,name==='request'?new Blob([JSON.stringify(rewrite(JSON.parse(await value.text())))],{type:'application/json'}):value);
    return http(url,{...init,body});
  };
}

export function clarifyText(request) {
  const r=structuredClone(request);
  r.questions.primary.instructions.question += ' Apply the trusted positive criteria and exceptions explicitly: identify language satisfying at least one positive criterion, preserve quoted-speaker attribution, then exclude neutral reporting or education. Civil disagreement alone is negative. Do not invent missing conversation. Assess only the supplied message.';
  return r;
}

export function observablePolicy(policy) {
  // Readability/context already have dedicated questions. Retain six optional
  // diagnostics so the two required observations fit the native eight-signal cap.
  return {...policy,supporting:[...policy.supporting.filter(s=>!['warning','insufficient','solicitation_visible','misleading_claim_visible'].includes(s.id)).slice(0,6),
    {id:'solicitation_visible',question:'Does the image visibly ask the recipient to provide money, credentials, account access, sensitive information or another benefit? A logo or ordinary advertisement alone is not such a request.'},
    {id:'misleading_claim_visible',question:'Does the image contain observable misleading claims or apparent impersonation connected to a solicitation? Urgency, a logo or unfamiliar language alone is insufficient. Do not claim verified fraud or infer private intent.'},
  ]};
}

export function summarizeSweep(rows,policies,gates) {
  const out={};
  for(const kind of ['text','content']) {
    const group=rows.filter(r=>r.kind===kind&&r.variant==='answerability_v2'&&r.answer&&!r.error);
    out[kind]=[];
    for(const positive of [.7,.8,.9,.95])for(const negative of [.05,.1,.2,.3]) {
      const evaluated=group.map(r=>({...r,predicted:decisionAt(r.answer,policies[kind==='text'?'textPolicy':'contentPolicy'],kind,gates[kind],positive,negative)}));
      out[kind].push({positive,negative,...summarizeDecisions(evaluated)});
    }
  }
  return out;
}

export function selectAbstentions(cases,rows) {
  if(cases.some(c=>c.split!=='diagnostic_tuning_only'))throw Error('protected_holdout');
  const index=new Map(cases.map(c=>[c.auditId,c]));
  return rows.filter(r=>r.variant==='answerability_v2'&&r.predicted==null&&!r.error&&r.gate?.blockedReasons?.includes('primary_review_band')).map(r=>{
    const c=index.get(r.auditId);if(!c||c.kind!==r.kind)throw Error('source_case_missing');
    return {...c,variant:c.kind==='text'?'text_clarified':'image_observables_tiles',priorId:r.id};
  });
}
