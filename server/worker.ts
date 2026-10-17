import { textDigest } from './text.js';
import { Historical, deferred } from './historical.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { assert, baseRecord, AppError, type Evaluation, type ImageMessage, type Match, type ModerationEvent, type ReferenceImage, type Rule, type Settings, type Action } from '../shared/domain.js';
import { Services, EvaluationFailure } from './services.js';
import { downloadAttachment, supportedAttachment } from './images.js';
import { resolvePolicy, fingerprint, type Decision } from './policy.js';
import { safeError } from './security.js';
export function monitored(m: ImageMessage, s: Settings): boolean {
    return s.monitoring && s.channels.includes(m.channelId) && !s.excludedChannels.includes(m.channelId) && (!m.bot || m.webhook || s.processBots) && (!m.webhook || s.processWebhooks);
}
export class Worker {
    private stopRequested = false;
    private liveTurns = 0;
    private healthAt = 0;
    constructor(readonly services: Services, private download = downloadAttachment, private enforcementAllowed = true) { }
    async historyStep() { return new Historical(this.services,this.download,()=>!this.stopRequested).step(); }
    stop() { this.stopRequested = true; }
    async ingest(m: ImageMessage) {
        if (this.stopRequested) return;
        if (m.userId === this.services.discord.botId)
            return;
        const images = m.attachments.filter(supportedAttachment);
        const settings = (await this.services.store.getSettings(m.guildId)).value;
        const text = settings.textModerationEnabled === true && (await this.services.store.all<Rule>('rules',m.guildId)).some(r=>r.type==='text' && r.enabled);
        if (!images.length && !text) return;
        if (monitored(m, settings))
            await this.services.store.enqueue({ ...m, content: undefined, ...(text ? {textDigest:textDigest(m.content)} : {}), attachments: images });
    }
    async run() {
        while (!this.stopRequested) {
            if(Date.now()-this.healthAt>10000) {
                const id='gateway:'+this.services.discord.botId;
                await this.services.store.durable.change(id,{id,guild:null,kind:'health',due:0,data:{}},r=>{r.data.online=this.services.discord.online;r.due=Date.now()+15000;}).catch(()=>{});
                this.healthAt=Date.now();
            }
            let job;
            if(this.liveTurns>=8) { this.liveTurns=0; try { await this.historyStep(); } catch {} }

            try {
                job = await this.services.store.claim();
            }
            catch {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            if (!job) {
                try { if(await this.historyStep()) continue; } catch {}
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            this.liveTurns++;
            let error: string | null = null;
            try {
                await this.process(job.message);
            }
            catch (e) {
                const wait=deferred(e);
                if(wait) {
                    const key='job:'+job.id;
                    const retries=await this.services.store.durable.change(key,{id:key,guild:null,kind:'delay',due:wait.until,data:{}},r=>{
                        if(!['rate_limit_deferred','jev_account_budget_exhausted'].includes(wait.code)) r.data.retries=(r.data.retries??0)+1;
                        return r.data.retries??0;
                    });
                    if(retries<3) { await this.services.store.defer(job.id,wait.until); continue; }
                }
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
        const hasText = settings.textModerationEnabled === true && !!original.textDigest;
        const attachmentIds=(m:ImageMessage)=>m.attachments.filter(supportedAttachment).map(a=>a.id).sort().join(',');
        if(hasText && attachmentIds(original)!==attachmentIds(live)) { await this.ingest(live); return; }
        if (!attachments.length && !hasText) return;
        if(hasText && original.textDigest !== textDigest(live.content)) {
            await this.services.audit(guild,'system','text_job.stale',live.messageId);
            await this.ingest(live); return;
        }
        if (!live.webhook) {
            const member = await discord.memberInfo(guild, live.userId);
            if (member.owner || member.administrator || member.roles.some(r => settings.exemptRoles.includes(r)))
                return;
        }
        const rules = await store.all<Rule>('rules', guild);
        const images = await store.all<ReferenceImage>('images', guild);
        const allMatches: Match[] = [];
        const processed: string[] = [];
        const previous = await store.messageEvaluations(guild,live.messageId);
        const imagePolicy=createHash('sha256').update(JSON.stringify(rules.filter(r=>r.enabled&&r.type!=='text').map(r=>fingerprint(r,images,settings)).sort())).digest('hex');
        if(hasText) {
            const active=rules.filter(r=>r.type==='text'&&r.enabled&&r.guildId===guild);
            const cached=active.flatMap(r=>previous.filter(e=>!e.test&&e.messageId===live.messageId&&e.outcome!=='error').flatMap(e=>e.matches).filter(m=>m.ruleId===r.id&&m.text?.sampleSha256===original.textDigest&&m.policyFingerprint===fingerprint(r,images,settings)).slice(0,1));
            try {
                const result=cached.length===active.length ? {matches:cached,inputTokens:0} : await this.services.evaluateText(guild,live.content,rules,images,settings);
                if(result.matches.length) {
                    allMatches.push(...result.matches); processed.push('text');
                    if(cached.length!==active.length) await store.put('evaluations',{...baseRecord(guild,randomUUID()),messageId:live.messageId,channelId:live.channelId,userId:live.userId,attachmentId:'text',matches:result.matches,outcome:result.matches.some(m=>m.text?.status==='insufficient_evidence')?'insufficient_evidence':'evaluated',error:null,inputTokens:result.inputTokens,model:settings.model,test:false} as Evaluation,0);
                }
            } catch(e) {
                const failed=e instanceof EvaluationFailure ? e.matches : [];
                await store.put('evaluations',{...baseRecord(guild,randomUUID()),messageId:live.messageId,channelId:live.channelId,userId:live.userId,attachmentId:'text',matches:failed,outcome:'error',error:safeError(e),inputTokens:e instanceof EvaluationFailure?e.inputTokens:0,model:settings.model,test:false} as Evaluation,0);
                await store.put('events',{...baseRecord(guild,randomUUID()),messageId:live.messageId,channelId:live.channelId,userId:live.userId,ruleId:null,intended:'review',actual:'suppressed',reason:safeError(e),matches:failed,reviewStatus:'open'} as ModerationEvent,0);
                throw e;
            }
        }
        for (const a of attachments) {
            if (await store.seen(guild, live.messageId, a.id)) {
                const cached=previous.filter(e=>!e.test&&e.messageId===live.messageId&&e.attachmentId===a.id&&e.outcome!=='error').slice(0,1)[0];
                if(cached && cached.policySnapshot===imagePolicy && cached.matches.every(m=>rules.some(r=>r.id===m.ruleId && (!m.policyFingerprint||m.policyFingerprint===fingerprint(r,images,settings))) && (m.content?.contextSource!=='posting_message'||m.content.contextSha256===createHash('sha256').update(live.content??'').digest('hex')))) {
                    allMatches.push(...cached.matches); processed.push(a.id); continue;
                }
            }
            try {
                const image = await this.download(a, live.channelId);
                const result = await this.services.evaluate(guild, a.id, image, rules, images, settings, 'moderation', live.content);
                const evaluation: Evaluation = { ...baseRecord(guild, randomUUID()), messageId: live.messageId, channelId: live.channelId, userId: live.userId, attachmentId: a.id, policySnapshot:imagePolicy, matches: result.matches, outcome: result.matches.some(m => m.provenance === 'exact_hash' || (m.probability !== null && m.probability >= 0.5)) ? 'evaluated' : 'no_match', error: null, inputTokens: result.inputTokens, hashComparisons: result.hashComparisons, model: result.matches.some(m => m.provenance === 'jev' || m.provenance === 'content') ? settings.model : null, test: false };
                await store.put('evaluations', evaluation, 0);
                allMatches.push(...result.matches);
                processed.push(a.id);
            }
            catch (e) {
                const evaluation: Evaluation = { ...baseRecord(guild, randomUUID()), messageId: live.messageId, channelId: live.channelId, userId: live.userId, attachmentId: a.id, matches: e instanceof EvaluationFailure ? e.matches : [], outcome: 'error', error: safeError(e), inputTokens: e instanceof EvaluationFailure ? e.inputTokens : 0, hashComparisons: e instanceof EvaluationFailure ? e.hashComparisons : 0, model: null, test: false };
                await store.put('evaluations', evaluation, 0);
                // An incomplete multi-image decision cannot safely resolve overlapping rules.
                throw e;
            }
        }
        if (!processed.length)
            return;
        for (const id of processed.filter(id=>id!=='text'))
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
            if (!this.enforcementAllowed) { event.reason = 'deployment_acceptance_required'; event.reviewStatus = 'open'; }
            await store.put('events', event, 0);
            return;
        }
        const outcomes: string[] = [];
        const source = await discord.currentMessage(message.channelId, message.messageId);
        if (source.guildId !== guild || source.userId !== message.userId || (decision.match.provenance !== 'text' && !source.attachments.some(a => a.id === decision.match.attachmentId))) {
            event.reason = 'matched_attachment_removed';
            if (decision.match.provenance === 'exact_hash') event.reviewStatus = 'open';
            await store.put('events', event, 0);
            return;
        }
        if (decision.match.content?.contextSource === 'posting_message' && (typeof source.content !== 'string' || createHash('sha256').update(source.content).digest('hex') !== decision.match.content.contextSha256)) {
            event.reason = 'posting_context_changed'; event.reviewStatus = 'open';
            await store.put('events', event, 0); return;
        }
        // Text can change a mixed-message policy outcome even when an image won precedence.
        const textEvidence=matches.filter(m=>m.text);
        const attachmentIds=(m:ImageMessage)=>m.attachments.filter(supportedAttachment).map(a=>a.id).sort().join(',');
        if(textEvidence.length && attachmentIds(source)!==attachmentIds(message)) {event.reason='message_attachments_changed';event.reviewStatus='open';await store.put('events',event,0);return;}
        if(textEvidence.some(m=>m.text!.sampleSha256!==textDigest(source.content))) {
            event.reason='message_text_changed'; event.reviewStatus='open';
            await store.put('events',event,0); return;
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
                if(textEvidence.length && !outcomes.includes('delete:success')) {
                    const fresh=await discord.currentMessage(message.channelId,message.messageId);
                    assert(fresh.guildId===guild && fresh.userId===message.userId && attachmentIds(fresh)===attachmentIds(message) && textEvidence.every(m=>m.text!.sampleSha256===textDigest(fresh.content)), 'message_text_changed',409);
                }
                assert(!this.stopRequested, 'worker_stopped', 503);
                await discord.perform({...message,content:undefined}, action, decision.rule.timeoutSeconds, decision.rule.reason);
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
        if (decision.match.provenance === 'exact_hash' && outcomes.some(o => o.includes(':suppressed') || o.endsWith(':paused'))) {
            event.reviewStatus = 'open';
            event.reason = `exact_hash:${outcomes.join(';')}`;
        }
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
