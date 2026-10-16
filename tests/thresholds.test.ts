import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, parseSettings, type Match, type Rule } from '../shared/domain.js';
import { resolvePolicy } from '../server/policy.js';
import { fixture, rule } from './helpers.js';
const comparison = (r: Rule, probability: number, extra: Partial<Match> = {}): Match => ({ ruleId: r.id, referenceId: r.referenceId, attachmentId: 'a', probability, verified: false, model: DEFAULT_SETTINGS.model, ...extra });

test('configured review and effective action thresholds include equality', async t => {
    const f = await fixture(t);
    for (const review of [0.5, 0.8, 0.91]) {
        for (const [threshold, floor] of [[0.93, 0.97], [0.98, 0.97]]) {
            const r = rule(f.ref, { action: 'warn', threshold });
            const s = parseSettings({ thresholds: { review, warn: floor } });
            const effective = Math.max(threshold!, floor!);
            for (const [p, expected] of [[review - 0.00001, null], [review, 'review'], [effective - 0.00001, 'review'], [effective, 'warn'], [1, 'warn']] as const) {
                const d = resolvePolicy([r], [comparison(r, p)], s, [f.ref]);
                assert.equal(d?.action ?? null, expected, `review=${review}, effective=${effective}, p=${p}`);
                if (expected === 'review') { assert.equal(d?.execute, false); assert.equal(d?.deleteMessage, false); }
            }
            s.uncertain = 'ignore';
            assert.equal(resolvePolicy([r], [comparison(r, review)], s, [f.ref]), null);
            assert.equal(resolvePolicy([r], [comparison(r, effective)], s, [f.ref])?.action, 'warn');
        }
    }
});

test('equal or higher review thresholds remain valid and do not raise the action floor', async t => {
    const f = await fixture(t), r = rule(f.ref, { threshold: 0.9, action: 'warn' });
    for (const review of [0.97, 0.99, 1]) {
        const s = parseSettings({ thresholds: { review, warn: 0.97 } });
        assert.equal(resolvePolicy([r], [comparison(r, 0.969)], s, [f.ref]), null);
        assert.equal(resolvePolicy([r], [comparison(r, 0.97)], s, [f.ref])?.action, 'warn');
    }
    const s = parseSettings({ thresholds: { review: 0.98, warn: 0.97 } });
    const higherRule = { ...r, threshold: 0.99 };
    assert.equal(resolvePolicy([higherRule], [comparison(r, 0.98)], s, [f.ref])?.action, 'review');
});

test('explicit review rules retain their rule floor and work under ignore', async t => {
    const f = await fixture(t), r = rule(f.ref, { action: 'review', threshold: 0.9 });
    const s = parseSettings({ uncertain: 'ignore' });
    assert.equal(resolvePolicy([r], [comparison(r, 0.899)], s, [f.ref]), null);
    const d = resolvePolicy([r], [comparison(r, 0.9)], s, [f.ref]);
    assert.equal(d?.action, 'review'); assert.equal(d?.execute, false); assert.equal(d?.deleteMessage, false);
});

test('invalid probabilities, wrong model and ineligible rules cannot enter either path', async t => {
    const f = await fixture(t), r = rule(f.ref), s = structuredClone(DEFAULT_SETTINGS);
    for (const p of [NaN, Infinity, -Infinity, -0.1, 1.001, '0.9' as unknown as number])
        assert.equal(resolvePolicy([r], [comparison(r, p)], s, [f.ref]), null);
    for (const p of [0.9, 1]) {
        assert.equal(resolvePolicy([r], [comparison(r, p, { model: 'jev-other' })], s, [f.ref]), null);
        assert.equal(resolvePolicy([], [comparison(r, p)], s, [f.ref]), null);
        for (const overrides of [{ enabled: false }, { mode: 'semantic' as const }, { type: 'any_image' as const, referenceId: null }])
            assert.equal(resolvePolicy([{ ...r, ...overrides }], [comparison(r, p)], s, [f.ref]), null);
    }
});

test('both paths preserve rule priority, specificity and ID independent of input order', async t => {
    const f = await fixture(t), s = structuredClone(DEFAULT_SETTINGS);
    const individual = rule(f.ref, { id: 'b' });
    const cases: [Rule[], string][] = [
        [[individual, rule(f.ref, { id: 'a', type: 'any_match', priority: 1 })], 'a'],
        [[individual, rule(f.ref, { id: 'a', type: 'group' })], 'b'],
        [[rule(f.ref, { id: 'b', type: 'group' }), rule(f.ref, { id: 'a', type: 'any_match' })], 'b'],
        [[individual, rule(f.ref, { id: 'a' })], 'a']
    ];
    for (const p of [0.9, 1]) for (const [rules, winner] of cases) {
        const matches = rules.map(r => comparison(r, p));
        for (const rs of [rules, [...rules].reverse()]) for (const ms of [matches, [...matches].reverse()])
            assert.equal(resolvePolicy(rs, ms, s, [f.ref])?.rule.id, winner);
    }
    const high = rule(f.ref, { priority: 100 });
    assert.equal(resolvePolicy([high, individual], [comparison(high, 0.9), comparison(individual, 1)], s, [f.ref])?.rule.id, individual.id);
});

test('comparison ties use attachment then reference ID, and conservative verification', async t => {
    const f = await fixture(t), r = rule(f.ref), s = structuredClone(DEFAULT_SETTINGS);
    for (const p of [0.9, 1]) {
        const winner = comparison(r, p, { referenceId: 'a' });
        const matches = [comparison(r, p - 0.01), comparison(r, p, { attachmentId: 'b' }), comparison(r, p, { referenceId: 'z' }), { ...winner, verified: true }, winner];
        assert.deepEqual(resolvePolicy([r], matches, s, [f.ref])?.match, winner);
        assert.deepEqual(resolvePolicy([r], [...matches].reverse(), s, [f.ref])?.match, winner);
    }
});
