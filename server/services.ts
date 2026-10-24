import type { Purpose, Attempt } from '../shared/analytics.js';
import { randomUUID } from 'node:crypto';
import { assert, AppError, baseRecord, effectiveAuthority, isSevere, type Authority, type Audit, type Calibration, type Credential, type ImageMessage, type Match, type ReferenceImage, type RoleGrant, type Rule, type Settings } from '../shared/domain.js';
import type { Store } from './store.js';
import { Vault, safeError } from './security.js';
import { JevClient, type JevResult } from './jev.js';
import { ObjectStore, normalize, NORMALIZATION_HASH_VERSION, type NormalizedImage } from './images.js';
import { fingerprint, referencesFor } from './policy.js';
import type { DiscordAdapter } from './discord.js';
export class EvaluationFailure extends AppError {
    constructor(error: unknown, readonly matches: Match[], readonly inputTokens: number, readonly hashComparisons: number) {
        super(safeError(error), 503);
    }
}
export class Services {
    constructor(readonly store: Store, readonly objects: ObjectStore, readonly vault: Vault, readonly jev: JevClient, readonly discord: DiscordAdapter) { }
    async audit(guild: string, actor: string, event: string, target: string, detail: Record<string, unknown> = {}, store: Store = this.store) {
        const record: Audit = { ...baseRecord(guild, randomUUID()), actor, event, target, detail };
        await store.put('audit', record, 0);
    }
    async authority(guild: string, user: string): Promise<Authority> { return effectiveAuthority(await this.discord.memberInfo(guild, user), await this.store.all<RoleGrant>('grants', guild)); }
    async credential(guild: string, store: Store = this.store): Promise<Credential | null> { return (await store.all<Credential>('credentials', guild))[0] ?? null; }
    async credentialStatus(guild: string) { const c = await this.credential(guild); return { configured: !!c, status: c?.status ?? 'missing', validatedAt: c?.validatedAt ?? null, lastError: c?.lastError ?? null, revision: c?.revision ?? 0 }; }
    async call(guild: string, submitted: Buffer, reference: Buffer, mode: Rule['mode'], model: string, verification = false, keyOverride?: string, purpose: Purpose = 'moderation', correlationId = randomUUID()): Promise<JevResult> {

        const c = keyOverride ? null : await this.credential(guild);

        const key = keyOverride ?? (c ? this.vault.decrypt(guild, c.encrypted) : null);

        assert(key, 'jev_credential_missing', 503);

        try {

            const persist = async (work: () => Promise<void>) => {

                // Retry only the same idempotent database write, never the provider request.

                for (let i = 0; i < 3; i++) try { await work(); return; } catch (e) {

                    if (e instanceof AppError && e.code === 'daily_jev_call_budget_exhausted') throw e;

                    if (i === 2) throw new AppError('usage_accounting_unavailable', 503);

                }

            };

            const result = await this.jev.compare(submitted, reference, { key, model, mode, verification,

                onAttempt: async info => {

                    assert(info, 'usage_attempt_missing', 503);

                    const a: Attempt = { ...info, guildId:guild, correlationId, model, purpose, mode, verification, completedAt:null, outcome:'reserved', error:null, inputTokens:null, rate:null, costMicros:null };

                    await persist(async () => { const settings = (await this.store.getSettings(guild)).value; await this.store.analytics.reserve(a, settings.dailyCallLimit); });

                },

                onDispatch: id => persist(() => this.store.analytics.dispatch(guild,id)),

                onComplete: (id, completion) => persist(() => this.store.analytics.finalize(guild,id,completion))

            });

            if (c?.status === 'error')

                await this.store.put('credentials', { ...c, status: 'valid', lastError: null, revision: c.revision + 1, updatedAt: new Date().toISOString() }, c.revision).catch(() => { });

            return result;

        }

        catch (e) {

            if (c && c.status !== 'error' && safeError(e).startsWith('jev_')) {

                const code = safeError(e);

                await this.store.put('credentials', { ...c, status: 'error', lastError: code, revision: c.revision + 1, updatedAt: new Date().toISOString() }, c.revision).catch(() => { });

                await this.audit(guild, 'system', 'jev.unhealthy', 'credential', { code }).catch(() => { });

                const settings = (await this.store.getSettings(guild)).value;

                if (settings.logChannel)

                    await this.discord.notify(guild, settings.logChannel, `TypeCheck: image evaluations are unhealthy (${code}). No punishment is performed for failed evaluations.`).catch(() => { });

            }

            throw e;

        }

    }

    async setCredential(guild: string, actor: string, key: string) {
        assert(key.length >= 8 && key.length <= 4096 && !/[\r\n]/.test(key), 'invalid_api_key');
        const before = await this.credential(guild);
        const settings = (await this.store.getSettings(guild)).value;
        const sample = await normalize(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64'));
        await this.call(guild, sample.bytes, sample.bytes, 'exact', settings.model, false, key, 'credential_validation');
        await this.store.withGuild(guild, async (tx) => {
            const current = await this.credential(guild, tx);
            assert((current?.revision ?? 0) === (before?.revision ?? 0), 'credential_changed_retry', 409);
            assert((await tx.getSettings(guild)).value.model === settings.model, 'model_changed_retry', 409);
            const now = new Date().toISOString();
            const record: Credential = { ...(current ?? baseRecord(guild, randomUUID())), revision: (current?.revision ?? 0) + 1, updatedAt: now, encrypted: this.vault.encrypt(guild, key), status: 'valid', validatedAt: now, lastError: null };
            await tx.put('credentials', record, current?.revision ?? 0);
            await this.audit(guild, actor, current ? 'credential.rotated' : 'credential.created', record.id, {}, tx);
        });
        return this.credentialStatus(guild);
    }
    async testCredential(guild: string) { const c = await this.credential(guild); assert(c, 'jev_credential_missing', 404); const key = this.vault.decrypt(guild, c.encrypted); await this.setCredential(guild, 'system-connection-check', key); return this.credentialStatus(guild); }
    async evaluate(guild: string, attachmentId: string, image: NormalizedImage, rules: Rule[], images: ReferenceImage[], settings: Settings, purpose: Purpose = 'moderation'): Promise<{
        matches: Match[];
        inputTokens: number;
        hashComparisons: number;
    }> {
        const matches: Match[] = [];
        let inputTokens = 0, hashComparisons = 0;
        const cache = new Map<string, JevResult>();
        const correlationId = randomUUID();
        const deadline = Date.now() + 120000;
        try {
        for (const rule of rules.filter(r => r.guildId === guild && r.enabled)) {
            if (rule.mode === 'semantic' && !settings.semanticEnabled)
                continue;
            if (rule.type === 'any_image') {
                if (settings.anyImageEnabled)
                    matches.push({ provenance: 'any_image', ruleId: rule.id, referenceId: null, probability: 1, verified: true, model: settings.model, attachmentId });
                continue;
            }
            const refs = referencesFor(rule, images);
            assert(refs.length <= 250, 'reference_comparison_limit');
            for (const ref of refs) {
                assert(Date.now() < deadline, 'evaluation_deadline_exceeded', 503);
                const binding = { referenceRevision: ref.revision, policyFingerprint: fingerprint(rule, images, settings) };
                if (image.hashVersion === NORMALIZATION_HASH_VERSION && image.hashVersion === ref.hashVersion && /^[a-f0-9]{64}$/.test(image.sha256) && image.sha256 === ref.sha256) {
                    matches.push({ ...binding, provenance: 'exact_hash', ruleId: rule.id, referenceId: ref.id, hashVersion: image.hashVersion, probability: null, model: null, verified: false, attachmentId });
                    hashComparisons++;
                    continue;
                }
                const compare = async (verification: boolean) => {
                    const k = `${guild}:${ref.sha256}:${ref.objectKey}:${rule.mode}:${settings.model}:${verification}`;
                    let r = cache.get(k);
                    if (!r) {
                        r = await this.call(guild, image.bytes, await this.objects.get(guild, ref.objectKey), rule.mode, settings.model, verification, undefined, purpose, correlationId);
                        cache.set(k, r);
                        inputTokens += r.inputTokens;
                    }
                    return r;
                };
                const result = await compare(false);
                const floor = Math.max(rule.threshold, settings.thresholds[rule.action]);
                let p = result.probability, verified = false;
                if (p >= floor && (rule.secondVerification || isSevere(rule.action))) {
                    const second = await compare(true);
                    p = Math.min(p, second.probability);
                    verified = second.probability >= floor;
                }
                matches.push({ ...binding, provenance: 'jev', ruleId: rule.id, referenceId: ref.id, probability: p, verified, model: result.model, attachmentId });
            }
        }
        } catch (error) { throw new EvaluationFailure(error, matches, inputTokens, hashComparisons); }
        return { matches, inputTokens, hashComparisons };
    }
    async testRule(guild: string, actor: string, ruleId: string, image: NormalizedImage, expected?: boolean) {
        const rule = await this.store.get<Rule>('rules', guild, ruleId);
        assert(rule, 'rule_not_found', 404);
        const images = await this.store.all<ReferenceImage>('images', guild);
        const settings = (await this.store.getSettings(guild)).value;
        assert(rule.type !== 'any_image' || settings.anyImageEnabled, 'any_image_mode_disabled');
        assert(rule.mode !== 'semantic' || settings.semanticEnabled, 'semantic_mode_disabled');
        const result = await this.evaluate(guild, 'test', image, [{ ...rule, enabled: true }], images, settings, 'rule_test');
        const exact = result.matches.some(m => m.provenance === 'exact_hash');
        const probability = exact ? null : Math.max(0, ...result.matches.map(m => m.probability ?? 0));
        const predicted = exact || probability! >= Math.max(rule.threshold, settings.thresholds[rule.action]);
        const fp = fingerprint(rule, images, settings);
        if (expected !== undefined) {
            const trial: Calibration = { ...baseRecord(guild, randomUUID()), ruleId, fingerprint: fp, provenance: exact ? 'exact_hash' : 'jev', model: exact ? null : settings.model, expected, predicted, probability, sampleSha256: image.sha256, actor };
            await this.store.put('calibrations', trial, 0);
        }
        await this.audit(guild, actor, 'rule.tested', ruleId, { expected: expected ?? null, predicted, probability });
        return { ...result, probability, predicted, fingerprint: fp, executed: false };
    }
    async approveRule(guild: string, actor: string, ruleId: string, note: string) {
        return this.store.withGuild(guild, async (tx) => {
            const rule = await tx.get<Rule>('rules', guild, ruleId);
            assert(rule, 'rule_not_found', 404);
            const images = await tx.all<ReferenceImage>('images', guild);
            const settings = (await tx.getSettings(guild)).value;
            const fp = fingerprint(rule, images, settings);
            assert(rule.mode !== 'semantic', 'semantic_automatic_enforcement_not_supported');
            let positives = 0, negatives = 0, falsePositives = 0, truePositives = 0;
            if (rule.type !== 'any_image') {
                assert(referencesFor(rule, images).length > 0, 'no_active_references');
                const currentTrials = (await tx.all<Calibration>('calibrations', guild)).filter(t => t.ruleId === ruleId && t.fingerprint === fp);
                // Deterministic false positives must not disappear from approval review.
                assert(!currentTrials.some(t => t.provenance === 'exact_hash' && !t.expected && t.predicted), 'calibration_failed');
                const trials = currentTrials.filter(t => t.model === settings.model && t.provenance !== 'exact_hash');
                const bySample = new Map<string, Calibration>();
                for (const t of trials) {
                    const old = bySample.get(t.sampleSha256);
                    assert(!old || old.expected === t.expected, 'conflicting_calibration_labels');
                    if (!old)
                        bySample.set(t.sampleSha256, t);
                }
                for (const t of bySample.values()) {
                    if (t.expected) {
                        positives++;
                        if (t.predicted)
                            truePositives++;
                    }
                    else {
                        negatives++;
                        if (t.predicted)
                            falsePositives++;
                    }
                }
                const severe = isSevere(rule.action);
                assert(positives >= (severe ? 5 : 1) && negatives >= (severe ? 20 : 1), 'more_labeled_examples_required');
                assert(falsePositives === 0 && truePositives > 0, 'calibration_failed');
            }
            else
                assert(settings.anyImageEnabled, 'any_image_mode_disabled');
            assert(note.trim().length >= 20 && note.length <= 1000, 'approval_note_minimum_20_characters');
            const updated: Rule = { ...rule, revision: rule.revision + 1, updatedAt: new Date().toISOString(), approval: { fingerprint: fp, actor, at: new Date().toISOString(), note } };
            await tx.put('rules', updated, rule.revision);
            await this.audit(guild, actor, 'rule.approved', ruleId, { fingerprint: fp, positives, negatives, falsePositives, truePositives }, tx);
            return updated;
        });
    }
}
