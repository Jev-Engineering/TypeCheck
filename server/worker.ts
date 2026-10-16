import { randomUUID } from 'node:crypto';
import { assert, baseRecord, AppError, type Evaluation, type ImageMessage, type Match, type ModerationEvent, type ReferenceImage, type Rule, type Settings, type Action } from '../shared/domain.js';
import { Services } from './services.js';
import { downloadAttachment, supportedAttachment } from './images.js';
import { resolvePolicy, fingerprint, type Decision } from './policy.js';
import { safeError } from './security.js';
export function monitored(m: ImageMessage, s: Settings): boolean {
    return s.monitoring && s.channels.includes(m.channelId) && !s.excludedChannels.includes(m.channelId) && (!m.bot || m.webhook || s.processBots) && (!m.webhook || s.processWebhooks);
}
export class Worker {
    private stopRequested = false;
    constructor(readonly services: Services, private download = downloadAttachment, private enforcementAllowed = true) { }
    stop() { this.stopRequested = true; }
    async ingest(m: ImageMessage) {
        if (this.stopRequested) return;
        if (m.userId === this.services.discord.botId)
            return;
        const images = m.attachments.filter(supportedAttachment);
        if (!images.length)
            return;
        const settings = (await this.services.store.getSettings(m.guildId)).value;
        if (monitored(m, settings))
            await this.services.store.enqueue({ ...m, attachments: images });
    }
    async run() {
        while (!this.stopRequested) {
            let job;
            try {
                job = await this.services.store.claim();
            }
            catch {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            if (!job) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            let error: string | null = null;
            try {
                await this.process(job.message);
            }
            catch (e) {
                error = safeError(e);
                await this.services.audit(job.guildId, 'system', 'job.failed', job.id, { code: error }).catch(() => { });
            }
            await this.services.store.finish(job.id, error).catch(() => { });
        }
    }
    async process(original: ImageMessage) {
        const { store, discord } = this.services;
        const guild = original.guildId;
        const settings = (await store.getSettings(guild)).value;
        if (!monitored(original, settings))
            return;
        // Refresh signed attachment URLs and verify that the same author/message still exists.
        const live = await discord.currentMessage(original.channelId, original.messageId);
        assert(live.guildId === guild && live.userId === original.userId, 'source_message_changed');
        const ids = new Set(original.attachments.map(a => a.id));
        const attachments = live.attachments.filter(a => ids.has(a.id) && supportedAttachment(a));
        if (!attachments.length)
            return;
        if (!live.webhook) {
            const member = await discord.memberInfo(guild, live.userId);
            if (member.owner || member.administrator || member.roles.some(r => settings.exemptRoles.includes(r)))
                return;
        }
        const rules = await store.all<Rule>('rules', guild);
        const images = await store.all<ReferenceImage>('images', guild);
        const allMatches: Match[] = [];
        const processed: string[] = [];
        for (const a of attachments) {
            if (await store.seen(guild, live.messageId, a.id))
                continue;
            try {
                const image = await this.download(a, live.channelId);
                const result = await this.services.evaluate(guild, a.id, image, rules, images, settings);
                const evaluation: Evaluation = { ...baseRecord(guild, randomUUID()), messageId: live.messageId, channelId: live.channelId, userId: live.userId, attachmentId: a.id, matches: result.matches, outcome: result.matches.some(m => m.probability >= 0.5) ? 'evaluated' : 'no_match', error: null, inputTokens: result.inputTokens, model: settings.model, test: false };
                await store.put('evaluations', evaluation, 0);
                allMatches.push(...result.matches);
                processed.push(a.id);
            }
            catch (e) {
                const evaluation: Evaluation = { ...baseRecord(guild, randomUUID()), messageId: live.messageId, channelId: live.channelId, userId: live.userId, attachmentId: a.id, matches: [], outcome: 'error', error: safeError(e), inputTokens: 0, model: settings.model, test: false };
                await store.put('evaluations', evaluation, 0);
                // An incomplete multi-image decision cannot safely resolve overlapping rules.
                throw e;
            }
        }
        if (!processed.length)
            return;
        for (const id of processed)
            await store.markSeen(guild, live.messageId, id);
        const decision = resolvePolicy(rules, allMatches, settings, images);
        if (!decision)
            return;
        await this.execute(live, decision, allMatches, images, settings);
    }
    async execute(message: ImageMessage, decision: Decision, matches: Match[], snapshotImages: ReferenceImage[], snapshotSettings: Settings) {
        const { store, discord } = this.services;
        const guild = message.guildId;
        const event: ModerationEvent = { ...baseRecord(guild, randomUUID()), messageId: message.messageId, channelId: message.channelId, userId: message.userId, ruleId: decision.rule.id, intended: decision.action, actual: 'suppressed', reason: decision.reason, matches, reviewStatus: decision.action === 'review' || !decision.execute ? 'open' : null };
        if (!decision.execute || !this.enforcementAllowed) {
            if (!this.enforcementAllowed) event.reason = 'deployment_acceptance_required';
            await store.put('events', event, 0);
            return;
        }
        const outcomes: string[] = [];
        const source = await discord.currentMessage(message.channelId, message.messageId);
        if (source.guildId !== guild || source.userId !== message.userId || !source.attachments.some(a => a.id === decision.match.attachmentId)) {
            event.reason = 'matched_attachment_removed';
            await store.put('events', event, 0);
            return;
        }
        const expected = fingerprint(decision.rule, snapshotImages, snapshotSettings);
        const actions: Action[] = [];
        if (decision.deleteMessage)
            actions.push('delete');
        if (!['delete', 'none', 'review'].includes(decision.action))
            actions.push(decision.action);
        for (const action of actions) {
            const slot = action === 'delete' ? 'delete' : 'user';
            let claimed = false;
            try {
                // Do network reads before taking the guild lock so pause/settings writes are not
                // blocked by a slow Discord preflight. Authority is refreshed for each action.
                const preflightSettings = (await store.getSettings(guild)).value;
                const member = message.webhook ? null : await discord.memberInfo(guild, message.userId);
                await discord.preflight(message, action, preflightSettings);
                // Claim is durably committed BEFORE the Discord mutation; no external mutation in a DB transaction.
                claimed = await store.withGuild(guild, async (tx) => {
                    const settings = (await tx.getSettings(guild)).value;
                    assert(monitored(message, settings) && settings.enforcement, 'enforcement_paused', 409);
                    const rules = await tx.all<Rule>('rules', guild), images = await tx.all<ReferenceImage>('images', guild);
                    const current = resolvePolicy(rules, matches, settings, images);
                    assert(current?.execute && current.rule.id === decision.rule.id && fingerprint(current.rule, images, settings) === expected, 'policy_changed', 409);
                    if (member)
                        assert(!member.owner && !member.administrator && !member.roles.some(r => settings.exemptRoles.includes(r)), 'protected_or_exempt_member', 403);
                    return tx.beginAction({ guildId: guild, messageId: message.messageId, slot, action, status: 'attempting', detail: '', createdAt: new Date().toISOString() });
                });
                if (!claimed) {
                    outcomes.push(`${action}:duplicate_suppressed`);
                    continue;
                }
                // A pause that committed after the claim still prevents this dispatch where observable.
                const latest = (await store.getSettings(guild)).value;
                if (!latest.enforcement || !monitored(message, latest)) {
                    await store.finishAction(guild, message.messageId, slot, 'suppressed', 'enforcement_paused');
                    outcomes.push(`${action}:paused`);
                    continue;
                }
                assert(!this.stopRequested, 'worker_stopped', 503);
                await discord.perform(message, action, decision.rule.timeoutSeconds, decision.rule.reason);
                await store.finishAction(guild, message.messageId, slot, 'success', '');
                outcomes.push(`${action}:success`);
            }
            catch (e) {
                const code = safeError(e);
                const unknown = claimed && (code === 'discord_network_unknown_outcome' || code === 'internal_error' || /^discord_http_5/.test(code));
                if (claimed)
                    await store.finishAction(guild, message.messageId, slot, unknown ? 'unknown' : 'failed', code).catch(() => { });
                outcomes.push(`${action}:${unknown ? 'unknown' : 'suppressed'}:${code}`);
            }
        }
        event.actual = outcomes.join(';');
        event.reason = 'execution_recorded';
        event.reviewStatus = outcomes.some(o => o.includes(':unknown')) ? 'open' : null;
        await store.put('events', event, 0);
        const settings = (await store.getSettings(guild)).value;
        const summary = `TypeCheck | user ${message.userId} | message ${message.messageId} | rule ${decision.rule.name} | ${event.actual}`;
        if (settings.logChannel) {
            const claimed = await store.beginAction({ guildId: guild, messageId: message.messageId, slot: 'log', action: 'notify', status: 'attempting', detail: '', createdAt: new Date().toISOString() });
            if (claimed) {
                try {
                    await discord.notify(guild, settings.logChannel, summary);
                    await store.finishAction(guild, message.messageId, 'log', 'success', '');
                }
                catch (e) {
                    await store.finishAction(guild, message.messageId, 'log', 'unknown', safeError(e)).catch(() => { });
                }
            }
        }
        if (settings.dmNotify && !message.webhook && outcomes.some(o => o.endsWith(':success'))) {
            const claimed = await store.beginAction({ guildId: guild, messageId: message.messageId, slot: 'dm', action: 'notify', status: 'attempting', detail: '', createdAt: new Date().toISOString() });
            if (claimed) {
                try {
                    await discord.dm(message.userId, `${decision.rule.reason}\n${event.actual}`);
                    await store.finishAction(guild, message.messageId, 'dm', 'success', '');
                }
                catch (e) {
                    await store.finishAction(guild, message.messageId, 'dm', 'unknown', safeError(e)).catch(() => { });
                }
            }
        }
    }
}
