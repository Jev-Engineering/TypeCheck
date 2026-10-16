import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { digest } from './security.js';
import { PROMPT_VERSION } from './policy.js';
import { JevClient } from './jev.js';
import { normalize } from './images.js';
import { assert, MODES, DEFAULT_SETTINGS, isSevere, type Action, type Mode } from '../shared/domain.js';
const manifestPath = process.argv[2];
assert(manifestPath, 'usage_npm_run_evaluate_--_manifest_json');
const key = process.env.TYPESAFE_EVAL_KEY;
assert(key, 'TYPESAFE_EVAL_KEY_required');
const model = process.env.JEV_MODEL ?? 'jev-1.14.0';
const root = dirname(resolve(manifestPath));
const cases = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    id: string;
    reference: string;
    sample: string;
    expected: boolean;
    mode: Mode;
    threshold: number;
    action?: Action;
    secondVerification?: boolean;
}[];
assert(Array.isArray(cases) && cases.length <= 500, 'maximum_500_cases');
const results: {
    id: string;
    mode: Mode;
    expected: boolean;
    predicted: boolean;
    threshold: number;
    probability: number;
    model: string;
    inputTokens: number;
    firstProbability: number;
    secondProbability: number | null;
    referenceSha256: string;
    sampleSha256: string;
}[] = [];
let attempts = 0;
const jev = new JevClient();
for (const c of cases) {
    assert(MODES.includes(c.mode) && typeof c.expected === 'boolean' && c.threshold >= 0.5 && c.threshold <= 1, 'invalid_case');
    const ref = await normalize(await readFile(resolve(root, c.reference)));
    const sample = await normalize(await readFile(resolve(root, c.sample)));
    assert(c.action === undefined || Object.hasOwn(DEFAULT_SETTINGS.thresholds, c.action), 'invalid_action');
    assert(c.secondVerification === undefined || typeof c.secondVerification === 'boolean', 'invalid_second_verification');
    const threshold = Math.max(c.threshold, c.action ? DEFAULT_SETTINGS.thresholds[c.action] : 0);
    const result = await jev.compare(sample.bytes, ref.bytes, { key, model, mode: c.mode, onAttempt: async () => { assert(++attempts <= 1000, 'evaluation_call_limit'); } });
    let secondProbability: number | null = null, inputTokens = result.inputTokens;
    if (result.probability >= threshold && (c.secondVerification || (c.action && isSevere(c.action)))) {
        const second = await jev.compare(sample.bytes, ref.bytes, {key, model, mode:c.mode, verification:true, onAttempt:async()=>{assert(++attempts <= 1000,'evaluation_call_limit');}});
        secondProbability = second.probability; inputTokens += second.inputTokens;
    }
    const probability = Math.min(result.probability, secondProbability ?? 1);
    results.push({ id: c.id, mode: c.mode, expected: c.expected, predicted: probability >= threshold, threshold, probability, model, inputTokens, firstProbability:result.probability, secondProbability, referenceSha256:ref.sha256, sampleSha256:sample.sha256 });
}
const summary = Object.fromEntries(MODES.map(mode => { const r = results.filter(r => r.mode === mode); return [mode, { total: r.length, tp: r.filter(x => x.expected && x.predicted).length, tn: r.filter(x => !x.expected && !x.predicted).length, fp: r.filter(x => !x.expected && x.predicted).length, fn: r.filter(x => x.expected && !x.predicted).length }]; }));
await writeFile('evaluation-results.json', JSON.stringify({ model, promptVersion:PROMPT_VERSION, manifestSha256:digest(await readFile(manifestPath)), at: new Date().toISOString(), live: true, productionAccuracyAccepted:false, approvalGranted:false, attempts, summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
