import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { JevClient } from './jev.js';
import { normalize } from './images.js';
import { assert, MODES, type Mode } from '../shared/domain.js';
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
}[] = [];
let attempts = 0;
const jev = new JevClient();
for (const c of cases) {
    assert(MODES.includes(c.mode) && typeof c.expected === 'boolean' && c.threshold >= 0.5 && c.threshold <= 1, 'invalid_case');
    const ref = await normalize(await readFile(resolve(root, c.reference)));
    const sample = await normalize(await readFile(resolve(root, c.sample)));
    const result = await jev.compare(sample.bytes, ref.bytes, { key, model, mode: c.mode, onAttempt: async () => { assert(++attempts <= 1000, 'evaluation_call_limit'); } });
    results.push({ id: c.id, mode: c.mode, expected: c.expected, predicted: result.probability >= c.threshold, threshold: c.threshold, ...result });
}
const summary = Object.fromEntries(MODES.map(mode => { const r = results.filter(r => r.mode === mode); return [mode, { total: r.length, tp: r.filter(x => x.expected && x.predicted).length, tn: r.filter(x => !x.expected && !x.predicted).length, fp: r.filter(x => !x.expected && x.predicted).length, fn: r.filter(x => x.expected && !x.predicted).length }]; }));
await writeFile('evaluation-results.json', JSON.stringify({ model, at: new Date().toISOString(), live: true, attempts, summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
