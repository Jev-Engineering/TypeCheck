import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, matchThreshold } from '../shared/domain.js';
import { CONTENT_MODELS, CONTENT_PRESETS, CONTENT_VERSION } from '../shared/content.js';
import { contentMetrics, type LabeledContentResult } from '../shared/content-metrics.js';
import { contentEligibility } from './content.js';
import { JevClient } from './jev.js';
import { normalize } from './images.js';
import { digest, safeError } from './security.js';
import { estimate, parseRate, type Attempt } from '../shared/analytics.js';

assert(process.env.ALLOW_PAID_CONTENT_EVALUATION === 'true', 'explicit_paid_content_evaluation_authorization_required');
const key = process.env.TYPESAFE_EVAL_KEY; assert(key, 'TYPESAFE_EVAL_KEY_required');
const model = process.env.JEV_MODEL ?? 'jev-1.14.0'; assert(CONTENT_MODELS.includes(model), 'unsupported_content_model');
const manifestPath = resolve(process.argv[2] ?? 'fixtures/content/manifest.json'), root = dirname(manifestPath);
const bytes = await readFile(manifestPath), cases = JSON.parse(bytes.toString('utf8'));
assert(Array.isArray(cases) && cases.length <= 500, 'maximum_500_cases');
const threshold = matchThreshold(Number(process.env.CONTENT_EVAL_THRESHOLD ?? .7));
const rate = process.env.JEV_EVAL_PRICING ? parseRate(JSON.parse(process.env.JEV_EVAL_PRICING)) : null;
assert(!rate || rate.model === model, 'pricing_model_mismatch');
const jev = new JevClient(), attempts: Attempt[] = [], results: (LabeledContentResult & Record<string, unknown>)[] = [];
let failure: string | null = null;
try {
    for (const c of cases) {
        assert(typeof c.id === 'string' && /^[a-z0-9_-]{1,80}$/.test(c.id) && typeof c.file === 'string', 'invalid_case');
        assert(typeof c.language === 'string' && c.language.length <= 40 && typeof c.category === 'string' && c.category.length <= 64, 'invalid_case');
        assert(['tuning', 'held_out'].includes(c.split) && [true, false, null].includes(c.expected), 'invalid_case');
        assert(c.postingContext === undefined || typeof c.postingContext === 'string' && c.postingContext.length <= 2000, 'invalid_case_context');
        const path = resolve(root, c.file), rel = relative(root, path); assert(!rel.startsWith('..') && !rel.includes(':'), 'fixture_path_outside_manifest');
        const preset = CONTENT_PRESETS.find(p => p.id === c.preset); assert(preset, 'unknown_preset');
        const definition = { ...preset.definition, contextSource: c.postingContext === undefined ? 'image_only' as const : 'posting_message' as const };
        const image = await normalize(await readFile(path)), correlationId = randomUUID();
        const answer = await jev.analyze(image.bytes, definition, c.postingContext, {
            key, model, mode: 'exact',
            onAttempt: async info => { assert(info && attempts.length < 1000, 'evaluation_call_limit'); attempts.push({ ...info, guildId: 'cli-only', correlationId, model, purpose: 'rule_test', mode: 'exact', analysisKind: 'content', verification: false, completedAt: null, outcome: 'reserved', error: null, inputTokens: null, rate, costMicros: null }); },
            onDispatch: async id => { attempts.find(a => a.id === id)!.outcome = 'dispatching'; },
            onComplete: async (id, completion) => { Object.assign(attempts.find(a => a.id === id)!, completion, { costMicros: estimate(completion.inputTokens, rate) }); }
        });
        const gate = contentEligibility(answer, definition, threshold);
        results.push({ id: c.id, category: c.category, language: c.language, split: c.split, expected: c.expected, predicted: gate.status === 'insufficient_evidence' ? null : gate.eligible, answer, ...gate, threshold, definition, sampleSha256: image.sha256, contextSha256: c.postingContext === undefined ? null : digest(c.postingContext), correlationId });
    }
} catch (error) { failure = safeError(error); process.exitCode = 1; }
await writeFile('content-evaluation-results.json', JSON.stringify({ live: true, model, promptVersion: CONTENT_VERSION, manifestSha256: digest(bytes), productionAccuracyAccepted: false, approvalGranted: false, failure, incomplete: results.length !== cases.length, requested: cases.length, completed: results.length, attempts, metrics: contentMetrics(results), results }, null, 2));
console.log(JSON.stringify({ completed: results.length, requested: cases.length, failure, metrics: contentMetrics(results) }, null, 2));
