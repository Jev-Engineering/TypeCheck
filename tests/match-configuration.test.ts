import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, DEFAULT_RULE_THRESHOLD, MATCH_THRESHOLDS, parseSettings, parseRule, matchThreshold, effectiveThreshold, storedRecord, storedSettings, type Rule, type Match } from '../shared/domain.js';
import { fingerprint, resolvePolicy } from '../server/policy.js';
import { fixture, rule, enable, G, ADMIN } from './helpers.js';

const legacy = { none: .95, review: .8, warn: .97, delete: .97, timeout: .99, kick: .999, ban: .999 };
test('new settings use shared Standard/Strict defaults with enforcement disabled', () => {
    assert.equal(DEFAULT_RULE_THRESHOLD, MATCH_THRESHOLDS.standard);
    assert.deepEqual(parseSettings({}).thresholds, { none: .7, delete: .7, warn: .7, timeout: .9, kick: .9, ban: .9, review: .7 });
    assert.equal(parseSettings({}).enforcement, false);
});
test('saved legacy floors survive reads and partial updates; only absent floors default', () => {
    const old = parseSettings({ thresholds: legacy });
    assert.deepEqual(old.thresholds, legacy);
    assert.deepEqual(parseSettings({ thresholds: { review: .76 } }, old).thresholds, { ...legacy, review: .76 });
    assert.equal(parseSettings({ thresholds: { delete: .88 } }).thresholds.delete, .88);
    assert.equal(parseSettings({ thresholds: { delete: .88 } }).thresholds.ban, .9);
    assert.deepEqual(old.thresholds, legacy);
});
for (const value of [.5, .7, .812345, .9, 1]) test(`shared validation accepts ${value} exactly`, () => assert.equal(matchThreshold(value), value));
for (const value of [.499999, 1.000001, NaN, Infinity, null, undefined, '0.7', true]) test(`shared validation rejects ${String(value)}`, () => {
    assert.throws(() => matchThreshold(value), /match_threshold_must_be_a_finite_number_from_0.5_to_1.0/);
    assert.throws(() => parseSettings({ thresholds: { review: value } }), /match_threshold/);
});
test('severity floor ordering permits equality and rejects reversed kick or ban', () => {
    assert.equal(parseSettings({ thresholds: { timeout: 1, kick: 1, ban: 1 } }).thresholds.ban, 1);
    assert.throws(() => parseSettings({ thresholds: { timeout: .91 } }), /severe_threshold/);
    assert.throws(() => parseSettings({ thresholds: { kick: .95, ban: .94 } }), /severe_threshold/);
});
test('rule parsing and stored records default only missing thresholds', async t => {
    const f = await fixture(t), r = rule(f.ref);
    const { id, guildId, revision, createdAt, updatedAt, approval, threshold, ...input } = r;
    assert.equal(parseRule(input).threshold, .7);
    assert.equal(parseRule(input, .987).threshold, .987);
    assert.equal(parseRule({ ...input, threshold: .812345 }).threshold, .812345);
    assert.throws(() => parseRule({ ...input, threshold: null }), /match_threshold/);
    const { threshold: ignored, ...missing } = r;
    assert.equal((storedRecord('rules', missing) as Rule).threshold, .7);
    assert.equal(storedRecord('rules', r).threshold, .99);
});
for (const threshold of [.5, .7, .812345, .9, 1]) test(`policy and rule tests use inclusive boundary ${threshold}`, async t => {
    const f = await fixture(t), r = rule(f.ref, { threshold, action: 'warn' });
    const initial = await f.store.getSettings(G);
    initial.value.thresholds.warn = .5;
    await f.store.putSettings(G, initial.value, initial.revision);
    const s = await enable(f, r);
    const m: Match = { ruleId: r.id, referenceId: r.referenceId, probability: threshold, verified: false, model: s.model, attachmentId: 'test' };
    assert.equal(resolvePolicy([r], [m], s, [f.ref])?.execute, true);
    assert.notEqual(resolvePolicy([r], [{ ...m, probability: threshold - .000001 }], s, [f.ref])?.execute, true);
    f.control.probability = threshold;
    const result = await f.services.testRule(G, ADMIN, r.id, f.image);
    assert.equal(result.probability, threshold);
    assert.equal(result.ruleThreshold, threshold);
    assert.equal(result.actionFloor, .5);
    assert.equal(result.effectiveThreshold, threshold);
    assert.equal(result.meetsThreshold, true);
    assert.equal(result.executed, false);
    f.control.probability = threshold - .000001;
    assert.equal((await f.services.testRule(G, ADMIN, r.id, f.image)).meetsThreshold, false);
    assert.equal(f.discord.performed.length, 0);
});
test('action floor overrides rule and changes invalidate approval without enabling enforcement', async t => {
    const f = await fixture(t), r = rule(f.ref, { threshold: .7 });
    const s = await enable(f, r);
    assert.equal(effectiveThreshold(r, s), .9);
    assert.notEqual(fingerprint(r, [f.ref], s), fingerprint({ ...r, threshold: .75 }, [f.ref], s));
    const changed = parseSettings({ thresholds: { timeout: .85 } }, s);
    const m: Match = { ruleId: r.id, referenceId: r.referenceId, probability: .9, verified: true, model: s.model, attachmentId: 'test' };
    assert.equal(resolvePolicy([r], [m], changed, [f.ref])?.reason, 'calibration_approval_required');
    f.control.probability = .9;
    const result = await f.services.testRule(G, ADMIN, r.id, f.image);
    assert.equal(result.ruleThreshold, .7);
    assert.equal(result.actionFloor, .9);
    assert.equal(result.effectiveThreshold, .9);
    assert.equal(result.meetsThreshold, true);
    assert.equal(parseSettings({ thresholds: { timeout: .85 } }).enforcement, false);
});
test('second verification still determines the returned score and match', async t => {
    const f = await fixture(t), r = rule(f.ref, { threshold: .7, action: 'ban' });
    await f.store.put('rules', r, 0);
    f.control.probability = .9; f.control.secondProbability = .899999;
    const result = await f.services.testRule(G, ADMIN, r.id, f.image);
    assert.equal(f.control.calls, 2);
    assert.equal(result.probability, .899999);
    assert.equal(result.meetsThreshold, false);
    assert.equal(result.executed, false);
});
test('any-image test marks threshold and score comparison inapplicable', async t => {
    const f = await fixture(t), r = rule(f.ref, { type: 'any_image', referenceId: null, threshold: 1 });
    const s = await f.store.getSettings(G); s.value.anyImageEnabled = true;
    await f.store.putSettings(G, s.value, s.revision); await f.store.put('rules', r, 0);
    const result = await f.services.testRule(G, ADMIN, r.id, f.image);
    assert.equal(result.thresholdApplies, false); assert.equal(result.effectiveThreshold, null);
    assert.equal(result.meetsThreshold, null); assert.equal(result.predicted, true);
    assert.equal(f.control.calls, 0); assert.equal(result.executed, false);
});

test('reading SQL settings preserves historical approval fingerprints and floor ordering', async t => {
    const f = await fixture(t), r = rule(f.ref);
    const saved = { ...DEFAULT_SETTINGS, thresholds: { ban: .999, kick: .999, none: .95, warn: .97, delete: .97, review: .8, timeout: .99 } };
    const loaded = storedSettings(saved);
    assert.equal(JSON.stringify(loaded.thresholds), JSON.stringify(saved.thresholds));
    assert.equal(fingerprint(r, [f.ref], loaded), fingerprint(r, [f.ref], saved));
});
