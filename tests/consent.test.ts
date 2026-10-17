import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, G, ADMIN } from './helpers.js';
import { DATA_USE_CONSENT_KEYS } from '../shared/domain.js';
import { Onboarding } from '../server/onboarding.js';
import { installTextStarters } from '../server/text-starters.js';
import { Packs, exportPack, validatePack } from '../server/packs.js';

test('consent is excluded from portable packs, rejected on import, and preserved in all destination combinations', async t => {
    const f = await fixture(t);
    const packs = new Packs(f.services);
    for (const typesafeReviewConsent of [false, true]) for (const completeTechTrainingConsent of [false, true]) {
        const settings = await f.store.getSettings(G);
        await f.store.putSettings(G, { ...settings.value, typesafeReviewConsent, completeTechTrainingConsent }, settings.revision);
        const pack = await exportPack(f.services, G, { complete: true });
        for (const key of DATA_USE_CONSENT_KEYS) {
            assert.equal(Object.hasOwn(pack.policy!.settings, key), false);
            for (const value of [true, false]) {
                const malicious = structuredClone(pack);
                malicious.policy!.settings[key] = value;
                await assert.rejects(validatePack(malicious), /consent_not_portable/);
                await assert.rejects(packs.preview(G, ADMIN, malicious, { policy: true }), /consent_not_portable/);
            }
        }
        const preview = await packs.preview(G, ADMIN, pack, { policy: true });
        await packs.apply(G, ADMIN, pack, { policy: true }, preview.token);
        const readback = (await f.store.getSettings(G)).value;
        assert.equal(readback.typesafeReviewConsent, typesafeReviewConsent);
        assert.equal(readback.completeTechTrainingConsent, completeTechTrainingConsent);
    }
    assert.equal((await f.store.all<any>('audit', G)).filter(a => a.event === 'data_use.consent_updated').length, 0);
    assert.equal(f.control.calls, 0);
});

test('onboarding and starter acceptance preserve all consent combinations and cannot grant consent', async t => {
    for (const typesafeReviewConsent of [false, true]) for (const completeTechTrainingConsent of [false, true]) {
        const f = await fixture(t), settings = await f.store.getSettings(G);
        await f.store.putSettings(G, { ...settings.value, typesafeReviewConsent, completeTechTrainingConsent }, settings.revision);
        const onboarding = new Onboarding(f.services);
        const chosen = { presets: ['community'], channels: [], excludedChannels: [], exemptRoles: [], logChannel: null, customizations: {} };
        await assert.rejects(onboarding.plan(G, ADMIN, 'consent-test', { ...chosen, typesafeReviewConsent: true }), /unknown_field/);
        const plan = await onboarding.plan(G, ADMIN, 'consent-test', chosen), ref = { planId: plan.id, digest: plan.digest };
        await onboarding.transition(G, ADMIN, 'consent-test', ref, 'accept');
        await onboarding.transition(G, ADMIN, 'consent-test', ref, 'apply');
        await installTextStarters(f.services, G, ADMIN);
        const readback = (await f.store.getSettings(G)).value;
        assert.equal(readback.typesafeReviewConsent, typesafeReviewConsent);
        assert.equal(readback.completeTechTrainingConsent, completeTechTrainingConsent);
        assert.equal((await f.store.all<any>('audit', G)).filter(a => a.event === 'data_use.consent_updated').length, 0);
        assert.equal(f.control.calls, 0);
    }
});
