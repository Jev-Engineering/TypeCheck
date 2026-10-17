// Benchmark-only experiments. Production requests, hashes, approvals and gates
// are unchanged. Any positive candidate still has to satisfy the production gate.
export const EXPERIMENT_VERSION = 'benchmark-evidence-v2';
export const POSITIVE_THRESHOLD = .9;
export const NEGATIVE_THRESHOLD = .1;

export function rewriteQuestions(request) {
  const copy = structuredClone(request);
  if (copy.questions.sufficient) {
    copy.questions.sufficient.instructions.question = 'Is the message understandable and is its speaker attribution and required context sufficiently clear to decide EITHER that the policy applies OR that it does not apply? Clear benign messages count as sufficient. This is about answerability, not evidence of a violation. Do not require prohibited conduct to be present.';
    copy.questions.sufficient.criteria = {
      true: 'Enough understandable message content and any necessary attribution/context to make a positive or negative policy decision, including a clearly benign message.',
      false: 'Unreadable, unintelligible, missing necessary context or genuinely ambiguous attribution prevents deciding either way.',
    };
    copy.questions.context.instructions.question = 'Classify the author stance toward any policy-relevant conduct. Choose other for an understandable benign message containing no such conduct. Choose insufficient_context only when missing information genuinely prevents a policy decision; absence of a violation is not missing context.';
  } else {
    copy.questions.readability.instructions.question = 'Can the visible evidence support either a positive or negative policy decision? Report readability of actual visible text, including clearly benign text. No prohibited conduct need be present. Do not guess unreadable words.';
    copy.questions.context.instructions.question = 'Classify visible framing toward any depicted policy-relevant conduct. Choose none when there is clearly no such conduct or relevant framing. Reserve insufficient_context for missing information necessary to decide; a benign image is not automatically missing context.';
  }
  return copy;
}

export function experimentTransport(http = fetch) {
  return async (url, init) => {
    if (typeof init.body === 'string') {
      return http(url, {...init, body: JSON.stringify(rewriteQuestions(JSON.parse(init.body)))});
    }
    const body = new FormData();
    for (const [name, value] of init.body.entries()) {
      if (name === 'request') {
        body.append(name, new Blob([JSON.stringify(rewriteQuestions(JSON.parse(await value.text())))], {type:'application/json'}));
      } else body.append(name, value);
    }
    return http(url, {...init, body});
  };
}

export function evidenceDecision(answer, definition, kind, productionGate) {
  const unavailable = kind === 'text'
    ? answer.sufficientProbability < POSITIVE_THRESHOLD || answer.context === 'insufficient_context'
    : ['partially_readable','insufficient_detail','unsupported'].includes(answer.readability)
      || definition.requireReadableText && answer.readability !== 'readable'
      || answer.context === 'insufficient_context';
  if (unavailable) return {eligible:false, status:'insufficient_evidence', blockedReasons:['input_not_decidable']};
  if (answer.probability <= NEGATIVE_THRESHOLD)
    return {eligible:false, status:'not_detected', blockedReasons:[], negativeReason:'clear_negative_with_decidable_input'};
  if (answer.probability < POSITIVE_THRESHOLD)
    return {eligible:false, status:'insufficient_evidence', blockedReasons:['primary_review_band']};
  return productionGate(answer, definition, POSITIVE_THRESHOLD);
}

export function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p=successes/total, d=1+z*z/total, c=(p+z*z/(2*total))/d;
  const h=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
  return {low:Math.max(0,c-h),high:Math.min(1,c+h),confidence:.95};
}

export function summarizeDecisions(rows) {
  const counts={total:rows.length,tp:0,tn:0,fp:0,fn:0,abstained:0,unlabeled:0,errors:0};
  for (const row of rows) {
    if (row.error) {counts.errors++;continue;}
    if (row.predicted == null) counts.abstained++;
    if (typeof row.expected !== 'boolean') {counts.unlabeled++;continue;}
    if (row.predicted == null) continue;
    counts[row.expected ? row.predicted ? 'tp':'fn' : row.predicted ? 'fp':'tn']++;
  }
  const labeled=rows.filter(r=>typeof r.expected==='boolean'&&!r.error);
  const positives=labeled.filter(r=>r.expected).length, negatives=labeled.length-positives;
  return {...counts,
    coverage:rows.length ? rows.filter(r=>r.predicted!=null&&!r.error).length/rows.length:null,
    precision:counts.tp+counts.fp ? counts.tp/(counts.tp+counts.fp):null,
    positiveDetectionRate:positives ? counts.tp/positives:null,
    falseFlagsPerLabeledNegative:negatives ? counts.fp/negatives:null,
    precisionCI:wilson(counts.tp,counts.tp+counts.fp),
    positiveDetectionCI:wilson(counts.tp,positives),
    falseFlagCI:wilson(counts.fp,negatives),
  };
}
