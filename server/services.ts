import { TEXT_VERSION, TEXT_LIMITS, parseText, textBoundary, type TextDefinition, type TextEvidence } from '../shared/text.js';
import { textDigest, textEligibility, type TextResult } from './text.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Deferred } from './throttle.js';
import { CONTENT_LIMITS, CONTENT_VERSION, parseContent, type ContentDefinition } from '../shared/content.js';
import { contentEligibility, type ContentResult } from './content.js';
import { createHash } from 'node:crypto';
import { analyticsQuery, type Purpose, type Attempt } from '../shared/analytics.js';
import { randomUUID } from 'node:crypto';
import { assert, AppError, baseRecord, effectiveAuthority, isSevere, type Authority, type Audit, type Calibration, type Credential, type ImageMessage, type Match, type ReferenceImage, type RoleGrant, type Rule, type Settings } from '../shared/domain.js';
import { effectiveThreshold } from '../shared/domain.js';
import type { Store } from './store.js';
import { Vault, safeError } from './security.js';
import { JevClient, type JevResult } from './jev.js';
import { ObjectStore, normalize, NORMALIZATION_HASH_VERSION, type NormalizedImage } from './images.js';
import { fingerprint, referencesFor, resolvePolicy } from './policy.js';
import type { DiscordAdapter } from './discord.js';
export class EvaluationFailure extends AppError {
    constructor(readonly cause: unknown, readonly matches: Match[], readonly inputTokens: number, readonly hashComparisons: number) {
        super(safeError(cause), 503);
    }
}
export interface HistoricalCallContext { scanId: string; cache: string; beforeAttempt: () => Promise<void> }
export const historicalCall = new AsyncLocalStorage<HistoricalCallContext>();
export class Services {
    constructor(readonly store: Store, readonly objects: ObjectStore, readonly vault: Vault, readonly jev: JevClient, readonly discord: DiscordAdapter) { }
    async audit(guild: string, actor: string, event: string, target: string, detail: Record<string, unknown> = {}, store: Store = this.store) {
        const record: Audit = { ...baseRecord(guild, randomUUID()), actor, event, target, detail };
        await store.put('audit', record, 0);
    }
    async authority(guild: string, user: string): Promise<Authority> { return effectiveAuthority(await this.discord.memberInfo(guild, user), await this.store.all<RoleGrant>('grants', guild)); }
    async credential(guild: string, store: Store = this.store): Promise<Credential | null> { return (await store.all<Credential>('credentials', guild))[0] ?? null; }
    async credentialStatus(guild: string) { const c = await this.credential(guild); return { configured: !!c, status: c?.status ?? 'missing', validatedAt: c?.validatedAt ?? null, lastError: c?.lastError ?? null, revision: c?.revision ?? 0 }; }
    private textInFlight = 0;
    async call(guild: string, submitted: Buffer, reference: Buffer, mode: Rule['mode'], model: string, verification = false, keyOverride?: string, purpose: Purpose = 'moderation', correlationId = randomUUID(), content?: { definition: ContentDefinition | TextDefinition; context?: string; ruleId: string; text?: string }): Promise<JevResult | ContentResult | TextResult> {
        const historical=historicalCall.getStore();
        const cacheId=historical ? 'call:'+createHash('sha256').update(JSON.stringify([historical.cache,mode,model,verification,content?.definition,content?.context,createHash('sha256').update(reference).digest('hex')])).digest('hex') : null;
        if(cacheId) { const cached=await this.store.durable.get(cacheId); if(cached) return cached.data; }
        const c = keyOverride ? null : await this.credential(guild);
        const key = keyOverride ?? (c ? this.vault.decrypt(guild, c.encrypted) : null);
        assert(key, 'jev_credential_missing', 503);
        assert(!(c?.status==='error'&&c.lastError==='jev_authentication_failed'),'jev_authentication_failed',503);
        try {
            const persist = async (work: () => Promise<void>) => {
                // Retry only the same idempotent database write, never the provider request.
                for (let i = 0; i < 3; i++) try { await work(); return; } catch (e) {
                    if (e instanceof AppError && e.code === 'daily_jev_call_budget_exhausted') throw e;
                    if (i === 2) throw new AppError('usage_accounting_unavailable', 503);
                }
            };
            const options = { key, model, mode, verification,
                onAttempt: async (info?: { id: string; retry: number; startedAt: string }) => {
                    assert(info, 'usage_attempt_missing', 503);
                    await historical?.beforeAttempt();
                    const a: Attempt = { ...info, ...(content ? { ruleIds: [content.ruleId], analysisKind: content.text === undefined ? 'content' as const : 'text' as const } : {}), guildId:guild, correlationId:historical?.scanId ?? correlationId, model, purpose, mode, verification, completedAt:null, outcome:'reserved', error:null, inputTokens:null, rate:null, costMicros:null };
                    await persist(async () => { const settings = (await this.store.getSettings(guild)).value; await this.store.analytics.reserve(a, settings.dailyCallLimit); });
                },
                onDispatch: (id: string) => persist(() => this.store.analytics.dispatch(guild,id)),
                onComplete: (id: string, completion: import('../shared/analytics.js').Completion) => persist(() => this.store.analytics.finalize(guild,id,completion))
            };
            const result = content ? content.text !== undefined ? await this.jev.analyzeText(content.text, content.definition as TextDefinition, options) : await this.jev.analyze(submitted, content.definition as ContentDefinition, content.context, options) : await this.jev.compare(submitted, reference, options);
            if(cacheId) await this.store.durable.change(cacheId,{id:cacheId,guild,kind:'call',due:0,data:result},()=>{});
            if (c?.status === 'error')
                await this.store.put('credentials', { ...c, status: 'valid', lastError: null, revision: c.revision + 1, updatedAt: new Date().toISOString() }, c.revision).catch(() => { });
            return result;
        }
        catch (e) {
            if (!(e instanceof Deferred) && c && c.status !== 'error' && safeError(e).startsWith('jev_')) {
                const code = safeError(e);
                await this.store.put('credentials', { ...c, status: 'error', lastError: code, revision: c.revision + 1, updatedAt: new Date().toISOString() }, c.revision).catch(() => { });
                await this.audit(guild, 'system', 'jev.unhealthy', 'credential', { code }).catch(() => { });
                const settings = (await this.store.getSettings(guild)).value;
                if (settings.logChannel)
                    await this.discord.notify(guild, settings.logChannel, `TypeCheck: moderation evaluations are unhealthy (${code}). No punishment is performed for failed evaluations.`).catch(() => { });
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
    async evaluate(guild: string, attachmentId: string, image: NormalizedImage, rules: Rule[], images: ReferenceImage[], settings: Settings, purpose: Purpose = 'moderation', postingContext?: string): Promise<{
        matches: Match[];
        inputTokens: number;
        hashComparisons: number;
    }> {
        const correlationId = randomUUID();
        const matches: Match[] = [];
        let inputTokens = 0, hashComparisons = 0;
        const cache = new Map<string, JevResult>();
        const deadline = Date.now() + 120000;
        try {
        const contentRules = rules.filter(r => r.guildId === guild && r.enabled && r.type === 'content');
        assert(contentRules.length <= CONTENT_LIMITS.rules, 'content_active_rule_limit', 503);
        assert(contentRules.reduce((n, r) => n + 5 + parseContent(r.content).supporting.length, 0) <= CONTENT_LIMITS.questions, 'content_question_limit', 503);
        for (const rule of rules.filter(r => r.guildId === guild && r.enabled && r.type !== 'text')) {
            if (rule.mode === 'semantic' && !settings.semanticEnabled)
                continue;
            if (rule.type === 'any_image') {
                if (settings.anyImageEnabled)
                    matches.push({ provenance: 'any_image', ruleId: rule.id, referenceId: null, probability: 1, verified: true, model: settings.model, attachmentId });
                continue;
            }
            if (rule.type === 'content') {
                const d = parseContent(rule.content);
                let context: string | undefined;
                if (d.contextSource === 'posting_message') {
                    assert(settings.contentMessageContext === true, 'content_message_context_disabled', 503);
                    assert(typeof postingContext === 'string' && postingContext.length <= CONTENT_LIMITS.context, 'content_context_unavailable_or_over_limit', 503);
                    context = postingContext;
                }
                const analyze = async (verification: boolean) => {
                    assert(Date.now() < deadline, 'evaluation_deadline_exceeded', 503);
                    const result = await this.call(guild, image.bytes, Buffer.alloc(0), 'exact', settings.model, verification, undefined, purpose, correlationId, { definition: d, context, ruleId: rule.id }) as ContentResult;
                    inputTokens += result.inputTokens;
                    assert(Date.now() < deadline, 'evaluation_deadline_exceeded', 503);
                    return result;
                };
                const first = await analyze(false), floor = effectiveThreshold(rule, settings);
                const gate = contentEligibility(first, d, floor);
                const evidence: import('../shared/content.js').ContentEvidence = { decision: { ruleRevision: rule.revision, ruleThreshold: rule.threshold, actionFloor: settings.thresholds[rule.action], effectiveThreshold: floor, action: rule.action, priority: rule.priority, automatic: rule.automatic, secondVerification: rule.secondVerification || isSevere(rule.action), deleteMessage: rule.deleteMessage, timeoutSeconds: rule.timeoutSeconds, approvalFingerprint: rule.approval?.fingerprint ?? null, globalEnforcement: settings.enforcement, highImpactEnabled: settings.highImpactEnabled, contextEnabled: settings.contentMessageContext === true, uncertain: settings.uncertain }, definition: d, promptVersion: CONTENT_VERSION, correlationId, contextSource: d.contextSource, contextSha256: context === undefined ? null : createHash('sha256').update(context).digest('hex'), sampleSha256: image.sha256, normalizationVersion: image.hashVersion ?? 'unknown', readability: first.readability, context: first.context, promotionProbability: first.promotionProbability, depictedProbability: first.depictedProbability, signals: first.signals, ...gate };
                const match: Match = { provenance: 'content', ruleId: rule.id, referenceId: null, probability: first.probability, verified: false, model: first.model, attachmentId, policyFingerprint: fingerprint(rule, images, settings), content: evidence };
                matches.push(match);
                if (gate.eligible && (rule.secondVerification || isSevere(rule.action))) {
                    let second: ContentResult;
                    try { second = await analyze(true); } catch (error) { evidence.eligible = false; evidence.status = 'insufficient_evidence'; evidence.blockedReasons.push('verification_failed'); throw error; }
                    const secondGate = contentEligibility(second, d, floor);
                    evidence.verification = { probability: second.probability, eligible: secondGate.eligible, readability: second.readability, context: second.context, promotionProbability: second.promotionProbability, depictedProbability: second.depictedProbability, signals: second.signals, blockedReasons: secondGate.blockedReasons };
                    match.verified = secondGate.eligible;
                    if (!match.verified) { evidence.eligible = false; evidence.status = 'insufficient_evidence'; evidence.blockedReasons.push('verification_conflict'); }
                }
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
                const floor = effectiveThreshold(rule, settings);
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

    async evaluateText(guild: string, submitted: unknown, rules: Rule[], images: ReferenceImage[], settings: Settings, purpose: Purpose = 'moderation', testing = false) {
        const active = rules.filter(r => r.guildId === guild && r.type === 'text' && r.enabled && (testing || settings.textModerationEnabled === true));
        const matches: Match[] = [];
        let inputTokens = 0;
        if (!active.length)
            return { matches, inputTokens, hashComparisons: 0 };
        assert(active.length <= TEXT_LIMITS.rules, 'text_active_rule_limit', 503);
        const boundary = textBoundary(submitted), digest = textDigest(submitted), correlationId = randomUUID();
        // Bounded admission, including tests; no unbounded in-memory wait queue.
        assert(this.textInFlight < 2, 'text_concurrency_limit', 429);
        this.textInFlight++;
        const deadline = Date.now() + 120000;
        try {
            for (const rule of active) {
                const d = parseText(rule.text), floor = effectiveThreshold(rule, settings);
                const evidence: TextEvidence = { modality: 'text', promptVersion: TEXT_VERSION, definition: d, sampleSha256: digest, correlationId, normalizationVersion: 'utf8-exact-v1', decision: { ruleRevision: rule.revision, ruleThreshold: rule.threshold, actionFloor: settings.thresholds[rule.action], effectiveThreshold: floor, approvalFingerprint: rule.approval?.fingerprint ?? null }, eligible: false, status: 'insufficient_evidence', blockedReasons: [boundary ?? 'not_evaluated'], context: 'insufficient_context', promotionProbability: null, sufficientProbability: null };
                const match: Match = { ruleId: rule.id, referenceId: null, provenance: 'text', probability: null, verified: false, model: settings.model, attachmentId: 'text', policyFingerprint: fingerprint(rule, images, settings), text: evidence };
                matches.push(match);
                if (boundary)
                    continue;
                const analyze = async (verification: boolean) => {
                    assert(Date.now() < deadline, 'evaluation_deadline_exceeded', 503);
                    const r = await this.call(guild, Buffer.alloc(0), Buffer.alloc(0), 'exact', settings.model, verification, undefined, purpose, correlationId, { definition: d, ruleId: rule.id, text: submitted as string }) as TextResult;
                    inputTokens += r.inputTokens;
                    assert(Date.now() < deadline, 'evaluation_deadline_exceeded', 503);
                    return r;
                };
                const first = await analyze(false), gate = textEligibility(first, d, floor);
                Object.assign(evidence, gate, { context: first.context, promotionProbability: first.promotionProbability, sufficientProbability: first.sufficientProbability });
                match.probability = first.probability;
                if (gate.eligible && (rule.secondVerification || isSevere(rule.action))) {
                    const second = await analyze(true), secondGate = textEligibility(second, d, floor);
                    evidence.verification = { probability: second.probability, eligible: secondGate.eligible, context: second.context, promotionProbability: second.promotionProbability, sufficientProbability: second.sufficientProbability };
                    match.verified = secondGate.eligible;
                    if (!secondGate.eligible)
                        Object.assign(evidence, { eligible: false, status: 'insufficient_evidence', blockedReasons: ['verification_conflict'] });
                }
            }
        }
        catch (e) {
            for (const m of matches)
                if (m.text)
                    Object.assign(m.text, { eligible: false, status: 'insufficient_evidence', blockedReasons: ['evaluation_failed'] });
            throw new EvaluationFailure(e, matches, inputTokens, 0);
        }
        finally {
            this.textInFlight--;
        }
        return { matches, inputTokens, hashComparisons: 0 };
    }
    async testTextRule(guild: string, actor: string, ruleId: string, submitted: unknown, expected?: boolean) {
        const rule = await this.store.get<Rule>('rules', guild, ruleId);
        assert(rule?.type === 'text', 'text_rule_not_found', 404);
        const settings = (await this.store.getSettings(guild)).value, images = await this.store.all<ReferenceImage>('images', guild);
        const result = await this.evaluateText(guild, submitted, [{ ...rule, enabled: true }], images, settings, 'rule_test', true);
        const match = result.matches[0]!, evidence = match.text!, fp = fingerprint(rule, images, settings);
        await this.store.put('evaluations', { ...baseRecord(guild, randomUUID()), messageId: 'test', channelId: 'test', userId: actor, attachmentId: 'text', matches: result.matches, outcome: evidence.status, error: null, inputTokens: result.inputTokens, model: settings.model, test: true } as import('../shared/domain.js').Evaluation, 0);
        if (expected !== undefined)
            await this.store.put('calibrations', { ...baseRecord(guild, randomUUID()), text: evidence, ruleId, fingerprint: fp, model: settings.model, expected, predicted: evidence.eligible, probability: match.probability, provenance: 'jev', sampleSha256: evidence.sampleSha256, actor } as Calibration, 0);
        await this.audit(guild, actor, 'text_rule.tested', ruleId, { expected: expected ?? null, status: evidence.status });
        const decision = resolvePolicy([{ ...rule, enabled: true }], result.matches, settings, images);
        return { ...result, status: evidence.status, predicted: evidence.eligible, probability: match.probability, ruleThreshold: rule.threshold, actionFloor: settings.thresholds[rule.action], effectiveThreshold: effectiveThreshold(rule, settings), verification: evidence.verification ?? null, expected: expected ?? null, policyOutcome: decision ? { action: decision.action, reason: decision.reason, wouldExecute: decision.execute } : { action: 'none', reason: settings.textModerationEnabled === true ? evidence.status : 'text_moderation_disabled', wouldExecute: false }, executed: false };
    }
    async testRule(guild: string, actor: string, ruleId: string, image: NormalizedImage, expected?: boolean, postingContext?: string) {
        const rule = await this.store.get<Rule>('rules', guild, ruleId);
        assert(rule, 'rule_not_found', 404);
        assert(rule.type !== 'text', 'text_rule_requires_text_sample');
        const images = await this.store.all<ReferenceImage>('images', guild);
        const settings = (await this.store.getSettings(guild)).value;
        assert(rule.type !== 'any_image' || settings.anyImageEnabled, 'any_image_mode_disabled');
        assert(rule.mode !== 'semantic' || settings.semanticEnabled, 'semantic_mode_disabled');
        const result = await this.evaluate(guild, 'test', image, [{ ...rule, enabled: true }], images, settings, 'rule_test', postingContext);
        if (rule.type === 'content') await this.store.put('evaluations', { ...baseRecord(guild, randomUUID()), messageId: 'test', channelId: 'test', userId: actor, attachmentId: 'test', matches: result.matches, outcome: result.matches[0]?.content?.status ?? 'not_evaluated', error: null, inputTokens: result.inputTokens, model: settings.model, hashComparisons: result.hashComparisons, test: true } as import('../shared/domain.js').Evaluation, 0);
        const exact = result.matches.some(m => m.provenance === 'exact_hash');
        const probability = exact ? null : Math.max(0, ...result.matches.map(m => m.probability ?? 0));
        const thresholdApplies = !exact && rule.type !== 'any_image';
        const actionFloor = settings.thresholds[rule.action];
        const effective = thresholdApplies ? effectiveThreshold(rule, settings) : null;
        const contentMatch = result.matches.find(m => m.provenance === 'content');
        const predicted = contentMatch ? contentMatch.content!.eligible : exact || (thresholdApplies ? probability! >= effective! : result.matches.length > 0);
        const fp = fingerprint(rule, images, settings);
        if (expected !== undefined) {
            const trial: Calibration = { ...(contentMatch?.content ? { content: contentMatch.content } : {}), ...baseRecord(guild, randomUUID()), ruleId, fingerprint: fp, provenance: exact ? 'exact_hash' : 'jev', model: exact ? null : settings.model, expected, predicted, probability, sampleSha256: image.sha256, actor };
            await this.store.put('calibrations', trial, 0);
        }
        await this.audit(guild, actor, 'rule.tested', ruleId, { expected: expected ?? null, predicted, probability });
        const decision = resolvePolicy([{ ...rule, enabled: true }], result.matches, settings, images);
        const correlations = new Set(result.matches.flatMap(m => m.content ? [m.content.correlationId] : []));
        const page = correlations.size ? await this.store.analytics.attempts(guild, analyticsQuery(new URLSearchParams('limit=100'))) : null;
        const attempts = page?.items.filter(a => correlations.has(a.correlationId)) ?? [];
        const currencies = [...new Set(attempts.flatMap(a => a.rate ? [a.rate.currency] : []))];
        const accounting = page ? { attempts: attempts.length, inputTokens: attempts.reduce((n, a) => n + (a.inputTokens ?? 0), 0), unknownUsage: attempts.filter(a => a.inputTokens === null).length, estimatedCostMicros: currencies.length === 1 ? attempts.reduce((n, a) => n + BigInt(a.costMicros ?? 0), 0n).toString() : null, currency: currencies.length === 1 ? currencies[0] : null, partial: !!page.next || currencies.length !== 1 || attempts.some(a => a.costMicros === null), label: 'Request-level estimate; not a provider invoice. Missing rates and unknown usage are excluded.' } : null;
        return { ...result, calibrationNote: exact ? 'exact_hash: identical reference images do not count toward approval calibration. Use content rules or non-identical references.' : null, accounting, policyOutcome: decision ? { action: decision.action, reason: decision.reason, wouldExecute: decision.execute } : { action: 'none', reason: 'not_detected', wouldExecute: false }, probability, predicted, ruleThreshold: rule.threshold, actionFloor, effectiveThreshold: effective, thresholdApplies, meetsThreshold: thresholdApplies ? probability! >= effective! : null, fingerprint: fp, executed: false };
    }
    async approveRule(guild: string, actor: string, ruleId: string, note: string) {
        return this.store.withGuild(guild, async (tx) => {
            const rule = await tx.get<Rule>('rules', guild, ruleId);
            assert(rule, 'rule_not_found', 404);
            const images = await tx.all<ReferenceImage>('images', guild);
            const settings = (await tx.getSettings(guild)).value;
            const fp = fingerprint(rule, images, settings);
            assert(rule.mode !== 'semantic', 'semantic_automatic_enforcement_not_supported');
            if(rule.type === 'text') assert(parseText(rule.text).configured, 'text_policy_configuration_required');
            let positives = 0, negatives = 0, falsePositives = 0, truePositives = 0;
            if (rule.type !== 'any_image') {
                assert(rule.type === 'text' || rule.type === 'content' || referencesFor(rule, images).length > 0, 'no_active_references');
                const currentTrials = (await tx.all<Calibration>('calibrations', guild)).filter(t => t.ruleId === ruleId && t.fingerprint === fp);
                // Deterministic false positives must not disappear from approval review.
                assert(!currentTrials.some(t => t.provenance === 'exact_hash' && !t.expected && t.predicted), 'calibration_failed');
                const trials = currentTrials.filter(t => t.model === settings.model && t.provenance !== 'exact_hash' && t.content?.status !== 'insufficient_evidence' && t.text?.status !== 'insufficient_evidence' && (rule.type === 'text' ? t.text?.modality === 'text' : !t.text));
                const bySample = new Map<string, Calibration>();
                for (const t of trials) {
                    const sampleKey = t.text ? `text:${t.sampleSha256}` : t.content ? `${t.sampleSha256}:${t.content.contextSha256 ?? 'image_only'}` : t.sampleSha256;
                    const old = bySample.get(sampleKey);
                    assert(!old || old.expected === t.expected, 'conflicting_calibration_labels');
                    if (!old)
                        bySample.set(sampleKey, t);
                }
                const positiveImages = new Set<string>(), negativeImages = new Set<string>(), detectedImages = new Set<string>();
                // Repeating a sample must not hide an earlier model false positive.
                assert(!trials.some(t => !t.expected && t.predicted), 'calibration_failed');
                for (const t of bySample.values()) {
                    if (t.expected) {
                        positiveImages.add(t.sampleSha256);
                        if (t.predicted) detectedImages.add(t.sampleSha256);
                    }
                    else {
                        negativeImages.add(t.sampleSha256);
                        if (t.predicted)
                            falsePositives++;
                    }
                }
                positives = positiveImages.size; negatives = negativeImages.size; truePositives = detectedImages.size;
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
