import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {evidenceDecision,summarizeDecisions} from './benchmark-variants.mjs';
const root=resolve(process.env.BENCHMARK_ROOT??'G:/datasets-deleteme/typecheck'),run=resolve(root,'experiments/evidence-v2');
const read=name=>JSON.parse(readFileSync(resolve(run,name),'utf8'));
const {textEligibility}=await import(pathToFileURL(resolve(run,'runtime/server/text.js')).href);
const {contentEligibility}=await import(pathToFileURL(resolve(run,'runtime/server/content.js')).href);
const policies=read('baseline-policies.json'),sources=read('private-source-map.json');
const rows=readFileSync(resolve(run,'results.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const byAudit=new Map(sources.map(s=>[s.auditId,s])),paired={};
for(const kind of ['text','content']){
  const group=rows.filter(r=>r.kind===kind&&r.variant==='answerability_v2'&&!r.error);
  const gate=kind==='text'?textEligibility:contentEligibility,definition=kind==='text'?policies.textPolicy:policies.contentPolicy;
  const matrix={baseline:[],gate_change_only:[],wording_change_only:[],wording_and_gate_change:[]};
  for(const row of group){
    const old=byAudit.get(row.auditId).baseline;
    matrix.baseline.push(old);
    const oldCandidate=evidenceDecision(old.answer,definition,kind,gate);
    matrix.gate_change_only.push({...old,predicted:oldCandidate.status==='insufficient_evidence'?null:oldCandidate.eligible});
    const production=gate(row.answer,definition,.9);
    matrix.wording_change_only.push({...row,predicted:production.status==='insufficient_evidence'?null:production.eligible});
    matrix.wording_and_gate_change.push(row);
  }
  paired[kind]={pairedCases:group.length,labelBasis:'published proxy labels; independent policy annotation pending',matrix:Object.fromEntries(Object.entries(matrix).map(([k,v])=>[k,summarizeDecisions(v)]))};
}
const detail=rows.filter(r=>r.variant==='detail_1536'&&!r.error);
const imageDetail={pairedCases:detail.length,baseline768:summarizeDecisions(detail.map(r=>byAudit.get(r.auditId).baseline)),analysis1536:summarizeDecisions(detail),labelBasis:'spam labels are not scam ground truth'};
const reference=sources.filter(s=>s.source.kind==='reference').map(s=>s.baseline);
const thresholds=[.5,.6,.7,.8,.9,.95].map(threshold=>({threshold,...summarizeDecisions(reference.map(r=>({...r,predicted:r.answer.probability>=threshold})))}));
const controls=Object.fromEntries([...new Set(rows.filter(r=>r.kind==='reference').map(r=>r.variant))].map(v=>[v,summarizeDecisions(rows.filter(r=>r.variant===v))]));
const controlThresholds=[.5,.7,.9].map(threshold=>({threshold,
  knownCopies:summarizeDecisions(rows.filter(r=>['resize_control','crop_control','collage_control'].includes(r.variant)).map(r=>({...r,predicted:r.answer?r.answer.probability>=threshold:r.predicted}))),
  differentSources:summarizeDecisions(rows.filter(r=>r.variant==='different_source_control').map(r=>({...r,predicted:r.answer?r.answer.probability>=threshold:r.predicted}))),
  exploratoryOnly:true,automaticActionThresholdChanged:false}));
const labeledFile=resolve(run,'audit/reconciled.json');
let gold=null;
if(existsSync(labeledFile)){
  const annotations=new Map(JSON.parse(readFileSync(labeledFile,'utf8')).map(c=>[c.id,c]));
  gold={};
  for(const variant of [...new Set(rows.map(r=>r.variant))]){
    const annotated=rows.filter(r=>r.variant===variant&&r.auditId).map(r=>{
      const label=annotations.get(r.auditId),key=r.kind==='text'?'toxicity':r.kind==='reference'?'partial_policy':r.variant==='visible_credential_request'?'credential_request_visible':'apparent_deceptive_solicitation';
      const trusted=label?.independentlyReviewed&&!label.adjudicationRequired&&label.labels.decidable===true;
      return {...r,expected:trusted?label.labels[key]:null};
    });
    // Synthetic controls have independent transform labels, not the source audit label.
    if(variant.endsWith('_control'))continue;
    gold[variant]=summarizeDecisions(annotated);
  }
}
const report={interim:read('status.json').state!=='completed',asOf:new Date().toISOString(),paired,imageDetail,referenceThresholdSweep:{exploratoryOnly:true,automaticThresholdChange:false,rows:thresholds},controls,controlThresholds,
  credentialObservation:{...summarizeDecisions(rows.filter(r=>r.variant==='visible_credential_request')),meaning:'Visible credential request is descriptive evidence and does not establish phishing.'},
  independentlyReviewedDiagnosticMetrics:gold,
  holdoutEvaluated:false,productionChangesApplied:false,accuracyAccepted:false,
  cautions:['Diagnostic sample is balanced and selected from observed baseline cases, not representative prevalence.','Metrics against published labels are proxy agreement, not corrected accuracy.','Fresh holdout stays blocked until independent policy labels and a frozen candidate/acceptance plan exist.','No production prompt, normalization hash or enforcement threshold has changed.']};
writeFileSync(resolve(run,'paired-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({interim:report.interim,pairedText:paired.text.pairedCases,pairedImages:paired.content.pairedCases,detailPairs:detail.length,goldLabelsAvailable:gold!==null,holdoutEvaluated:false}));
