import { createHash, randomUUID } from 'node:crypto';
import { assert, baseRecord, effectiveThreshold, type Rule, type ReferenceImage, type Evaluation, type ModerationEvent, type ImageMessage } from '../shared/domain.js';
import type { HistoricalScan, ScanChannel } from '../shared/historical.js';
import { Services, EvaluationFailure, historicalCall } from './services.js';
import { supportedAttachment, downloadAttachment } from './images.js';
import { Deferred, Throttle, retryAt } from './throttle.js';
import { safeError } from './security.js';
import type { DurableRow } from './durable.js';
const NEVER = 8640000000000000;
const terminal = (s: HistoricalScan) => ['completed','completed_with_gaps','cancelled','failed'].includes(s.status);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function snowflakeAt(time: number) { return ((BigInt(Math.floor(time))-1420070400000n)<<22n).toString(); }
export function deferred(error: unknown): Deferred | null { return error instanceof Deferred ? error : error instanceof EvaluationFailure ? deferred(error.cause) : null; }
export class Historical {
    constructor(readonly services: Services, private download = downloadAttachment, private allowed = ()=>true) {}
    private row(scan: HistoricalScan): DurableRow { return {id:'scan:'+scan.id,guild:scan.guildId,kind:'scan',due:scan.nextAttempt,data:scan}; }
    async get(guild: string, id: string): Promise<HistoricalScan> { const r=await this.services.store.durable.get('scan:'+id); assert(r?.guild===guild,'scan_not_found',404); return r.data; }
    async list(guild: string) { return (await this.services.store.durable.list('scan',guild,NEVER,100)).map(r=>r.data as HistoricalScan); }
    private async change(scan: HistoricalScan, update: (s: HistoricalScan) => void) {
        return this.services.store.durable.change('scan:'+scan.id,{...this.row(scan),data:null},row=>{ assert(row.data,'scan_expired',404); const s=row.data as HistoricalScan; update(s); row.due=['running','throttled'].includes(s.status)?s.nextAttempt:NEVER; return structuredClone(s); });
    }
    async admin(guild: string, actor: string) { const a=await this.services.authority(guild,actor); assert(a.owner||a.administrator,'administrator_required',403); }
    async policy(guild: string) {
        const settings=await this.services.store.getSettings(guild), rules=await this.services.store.all<Rule>('rules',guild), images=await this.services.store.all<ReferenceImage>('images',guild);
        const credential=await this.services.credential(guild);
        return {settings:settings.value,rules,images, fingerprint:hash([settings,rules,images,credential?.encrypted??null])};
    }
    async prepare(guild: string, actor: string, input: any): Promise<HistoricalScan> {
        await this.admin(guild,actor);
        assert(input && typeof input==='object','invalid_scan');
        assert(Object.keys(input).every(k=>['channels','exclusions','from','to','budgets'].includes(k)),'invalid_scan_option');
        const validIds=(v: unknown): v is string[] => Array.isArray(v)&&v.length<=500&&v.every(x=>typeof x==='string'&&/^\d{6,22}$/.test(x));
        assert(input.channels==='all'||validIds(input.channels),'invalid_scan_channels');
        assert(validIds(input.exclusions??[]),'invalid_scan_exclusions');
        const now=Date.now(), end=input.to ? Date.parse(input.to) : now, start=input.from ? Date.parse(input.from) : null;
        assert(Number.isFinite(end)&&end<=now&&end>=1420070400000&&(start===null||(Number.isFinite(start)&&start<end&&start>=1420070400000)),'invalid_scan_dates');
        const budgets=input.budgets;
        assert(budgets&&Object.keys(budgets).every(k=>['messages','images','requests'].includes(k)),'invalid_scan_budgets');
        assert(budgets&&['messages','images','requests'].every(k=>Number.isSafeInteger(budgets[k])&&budgets[k]>=1&&budgets[k]<=1000000),'invalid_scan_budgets');
        const gateway=await this.services.store.durable.get('gateway:'+this.services.discord.botId);
        assert(this.services.discord.online||(gateway?.data.online&&gateway.due>Date.now()),'gateway_intents_or_connection_unavailable',503);
        assert(this.services.discord.history,'history_unavailable',503);
        const policy=await this.policy(guild);
        assert(policy.rules.some(r=>r.enabled),'no_active_rules');
        assert((await this.services.credentialStatus(guild)).status==='valid','jev_credential_unavailable');
        const metadata=await this.services.discord.metadata(guild);
        assert(metadata.channels.length<=500,'scan_channel_limit');
        const cutoff=new Date(end).toISOString(), before=snowflakeAt(end), channels: ScanChannel[]=[];
        const selected=input.channels==='all'?null:new Set<string>(input.channels);
        for(const c of metadata.channels) {
            let reason: string|null=null;
            if(![0,5].includes(c.type)) reason='unsupported_container';
            else if(selected&&!selected.has(c.id)) reason='not_selected';
            else if((input.exclusions??[]).includes(c.id)||policy.settings.excludedChannels.includes(c.id)) reason='excluded_channel';
            if(!reason) try {
                await this.services.discord.assertCanReadMessage(guild,actor,c.id);
                await this.services.discord.assertCanReadMessage(guild,this.services.discord.botId,c.id);
            } catch(e) { if(deferred(e)) throw e; reason=safeError(e); }
            channels.push({id:c.id,name:c.name??c.id,status:reason?'excluded':'pending',reason,before});
        }
        if(selected) for(const id of selected) if(!channels.some(c=>c.id===id)) channels.push({id,name:id,status:'excluded',reason:'channel_unavailable',before});
        assert(channels.length<=500,'scan_channel_limit');
        assert(channels.some(c=>c.status==='pending'),'no_eligible_channels');
        return {id:randomUUID(),guildId:guild,actor,createdAt:new Date(now).toISOString(),cutoff,from:start===null?null:new Date(start).toISOString(),policy:policy.fingerprint,
            status:'running',reason:null,nextAttempt:now,channels,channelIndex:0,threadCoverage:'Excluded: all threads, archived threads and forum/media posts. Full server coverage is not claimed.',budgets:{...budgets},
            counters:{messages:0,images:0,matches:0,skipped:0,failed:0,requests:0,reused:0},failures:[],pending:null,retries:0,mode:'review_only'};
    }
    async start(guild: string, actor: string, input: unknown) {
        const scan=await this.prepare(guild,actor,input);
        const release=await new Throttle(this.services.store.durable).enter('scan-start:'+guild,0);
        try {
            assert(await this.services.store.durable.activeScans(guild)<5,'active_scan_limit');
            await this.services.store.durable.change('scan:'+scan.id,this.row(scan),()=>{});
        } finally { await release(); }
        return scan;
    }
    async control(guild: string, actor: string, id: string, action: string) {
        await this.admin(guild,actor); const scan=await this.get(guild,id);
        assert(['pause','resume','cancel'].includes(action),'invalid_scan_action');
        if(action==='resume') { assert((await this.policy(guild)).fingerprint===scan.policy,'scan_policy_changed_start_new_scan',409); await this.admin(guild,scan.actor); }
        return this.change(scan,s=>{
            assert(!terminal(s),'scan_terminal',409);
            if(action==='resume') assert(s.counters.messages<s.budgets.messages&&s.counters.images<s.budgets.images&&s.counters.requests<s.budgets.requests,'scan_budget_exhausted_start_new_scan',409);
            s.status=action==='cancel'?'cancelled':action==='pause'?'paused':'running'; s.reason=action; s.nextAttempt=action==='resume'?Date.now():NEVER;
        });
    }
    private async current(scan: HistoricalScan) {
        assert(this.allowed(),'worker_stopped',503);
        if(!this.services.discord.online) throw new Deferred(Date.now()+5000,'gateway_unavailable');
        const latest=await this.get(scan.guildId,scan.id);
        assert(['running','throttled'].includes(latest.status),'scan_not_running',409);
        await this.admin(scan.guildId,scan.actor);
        assert((await this.policy(scan.guildId)).fingerprint===scan.policy,'scan_policy_changed',409);
        const c=scan.channels[scan.channelIndex]!;
        await this.services.discord.assertCanReadMessage(scan.guildId,scan.actor,c.id);
        await this.services.discord.assertCanReadMessage(scan.guildId,this.services.discord.botId,c.id);
    }
    // Called by the elected serial worker, never a second controller. One attachment or
    // one message page per turn, with persisted ownership and cursor before any evaluation.
    async step(): Promise<boolean> {
        const row=(await this.services.store.durable.list('scan',null,Date.now(),1))[0];
        if(!row) return false;
        let scan=row.data as HistoricalScan;
        if(!['running','throttled'].includes(scan.status)) return false;
        let index=scan.channelIndex;
        while(index<scan.channels.length&&scan.channels[index]!.status!=='pending') index++;
        if(index===scan.channels.length) { await this.change(scan,s=>{if(!['running','throttled'].includes(s.status))return;s.status=s.channels.some(c=>c.status==='complete')?'completed_with_gaps':'failed';s.reason='threads_and_forum_posts_excluded';s.nextAttempt=NEVER;}); return true; }
        scan=await this.change(scan,s=>{if(!['running','throttled'].includes(s.status))return;s.channelIndex=index;s.nextAttempt=Date.now()+100;s.status='running';});
        if(!['running','throttled'].includes(scan.status))return true;
        const channel=scan.channels[index]!;
        try {
            await this.current(scan);
            if(!scan.pending) {
                if(scan.counters.messages>=scan.budgets.messages) throw new Error('scan_message_budget');
                const page=await this.services.discord.history!(scan.guildId,channel.id,channel.before);
                const m=page[0];
                if(!m||(scan.from&&BigInt(m.messageId)<BigInt(snowflakeAt(Date.parse(scan.from))))) {
                    await this.change(scan,s=>{s.channels[index]!.status='complete';s.channelIndex++;s.retries=0;}); return true;
                }
                assert(m.guildId===scan.guildId&&m.channelId===channel.id&&BigInt(m.messageId)<BigInt(channel.before),'invalid_history_cursor');
                await this.change(scan,s=>{
                    if(!['running','throttled'].includes(s.status)) return;
                    s.counters.messages++;s.retries=0;
                    // IDs only: signed URLs and posting text never enter scan persistence.
                    s.pending={editedAt:m.editedAt??null,message:m.messageId,user:m.userId,attachments:m.attachments.map(a=>a.id),index:0};
                }); return true;
            }
            const pending=scan.pending;
            if(pending.index>=pending.attachments.length) {
                await this.change(scan,s=>{s.channels[index]!.before=pending.message;s.pending=null;s.retries=0;}); return true;
            }
            if(!pending.imageReserved&&scan.counters.images>=scan.budgets.images) throw new Error('scan_image_budget');
            const live=await this.services.discord.currentMessage(channel.id,pending.message);
            assert(live.guildId===scan.guildId&&live.userId===pending.user,'source_message_changed');
            assert((live.editedAt??null)===pending.editedAt,'source_message_edited');
            const attachment=live.attachments.find(a=>a.id===pending.attachments[pending.index]);
            assert(attachment,'matched_attachment_removed');
            assert(supportedAttachment(attachment),'unsupported_attachment');
            const policy=await this.policy(scan.guildId);
            assert(policy.fingerprint===scan.policy,'scan_policy_changed');
            assert(live.userId!==this.services.discord.botId&&(!live.bot||live.webhook||policy.settings.processBots)&&(!live.webhook||policy.settings.processWebhooks),'excluded_author');
            if(!live.webhook) { const member=await this.services.discord.memberInfo(scan.guildId,live.userId); assert(!member.owner&&!member.administrator&&!member.roles.some(r=>policy.settings.exemptRoles.includes(r)),'protected_or_exempt_member'); }
            if(!pending.imageReserved) await this.change(scan,s=>{
                assert(['running','throttled'].includes(s.status),'scan_not_running',409);
                assert(s.counters.images<s.budgets.images,'scan_image_budget',429);
                s.counters.images++;s.pending!.imageReserved=true;
            });
            const receipt='result:'+hash([scan.guildId,scan.policy,live.messageId,attachment.id,live.editedAt??null]);
            const old=await this.services.store.durable.get(receipt);
            let matches=old?.data.matches as number | undefined;
            if(matches===undefined) {
                const image=await this.download(attachment,channel.id);
                await this.current(scan);
                let attemptsThisTurn=0;
                const result=await historicalCall.run({scanId:scan.id,cache:receipt+':'+image.sha256,beforeAttempt:async()=>{
                    if(attemptsThisTurn++) throw new Deferred(Date.now()+100,'scan_quantum');
                    await this.current(scan);
                    await this.change(scan,s=>{assert(['running','throttled'].includes(s.status),'scan_not_running',409);assert(s.counters.requests<s.budgets.requests,'scan_request_budget',429);s.counters.requests++;});
                }},()=>this.services.evaluate(scan.guildId,attachment.id,image,policy.rules,policy.images,policy.settings,'moderation',live.content));
                await this.admin(scan.guildId,scan.actor);
                await this.services.discord.assertCanReadMessage(scan.guildId,scan.actor,channel.id);
                await this.services.discord.assertCanReadMessage(scan.guildId,this.services.discord.botId,channel.id);
                assert((await this.policy(scan.guildId)).fingerprint===scan.policy,'scan_policy_changed');
                const refreshed=await this.services.discord.currentMessage(channel.id,live.messageId);
                assert(refreshed.userId===live.userId&&(refreshed.editedAt??null)===(live.editedAt??null)&&refreshed.attachments.some(a=>a.id===attachment.id),'source_message_changed_during_evaluation');
                const id=hash(receipt).slice(0,32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
                const evaluation: Evaluation={...baseRecord(scan.guildId,id),...{historical:{scanId:scan.id,policy:scan.policy,cutoff:scan.cutoff}},messageId:live.messageId,channelId:channel.id,userId:live.userId,attachmentId:attachment.id,matches:result.matches,outcome:'historical_review',error:null,inputTokens:result.inputTokens,hashComparisons:result.hashComparisons,model:result.matches.some(m=>m.provenance==='jev'||m.provenance==='content')?policy.settings.model:null,test:false};
                // Deterministic record IDs make recovery after evidence write idempotent.
                if(!await this.services.store.get('evaluations',scan.guildId,id)) await this.services.store.put('evaluations',evaluation,0);
                const detected=result.matches.filter(m=>{
                    const r=policy.rules.find(r=>r.id===m.ruleId);
                    return m.provenance==='exact_hash'||m.provenance==='any_image'||(m.content?m.content.eligible:!!r&&m.probability!==null&&m.probability>=effectiveThreshold(r,policy.settings));
                });
                matches=detected.length;
                if(matches&&!await this.services.store.get('events',scan.guildId,id)) {
                    const event: ModerationEvent={...baseRecord(scan.guildId,id),...{historical:{scanId:scan.id,policy:scan.policy,cutoff:scan.cutoff}},messageId:live.messageId,channelId:channel.id,userId:live.userId,ruleId:detected[0]!.ruleId,intended:'review',actual:'suppressed',reason:'historical_review_only',matches:result.matches,reviewStatus:'open'};
                    await this.services.store.put('events',event,0);
                }
                await this.services.store.durable.change(receipt,{id:receipt,guild:scan.guildId,kind:'result',due:0,data:{matches}},()=>{});
            }
            await this.change(scan,s=>{s.counters.matches+=matches!;if(old)s.counters.reused++;if(s.pending){s.pending.index++;s.pending.imageReserved=false;}s.retries=0;});
        } catch(error) {
            const wait=deferred(error), code=error instanceof Error&&error.message.startsWith('scan_')?error.message:safeError(error);
            await this.change(scan,s=>{
                if(!['running','throttled'].includes(s.status)) return;
                s.reason=code;
                if(wait) {
                    if(!['rate_limit_deferred','jev_account_budget_exhausted','scan_quantum','gateway_unavailable'].includes(wait.code) && ++s.retries>=3) {
                        s.counters.failed++; if(s.failures.length<100)s.failures.push({reason:'retry_budget_exhausted:'+wait.code,channel:channel.id});
                        if(s.pending) {s.pending.index++;s.pending.imageReserved=false;} else {s.channels[index]!.status='failed';s.channels[index]!.reason='retry_budget_exhausted';s.channelIndex++;}
                        s.retries=0;
                    }
                    s.status='throttled';s.nextAttempt=wait.until;return;
                }
                if(code.includes('budget')||code==='daily_jev_call_budget_exhausted') {s.status='budget_paused';s.nextAttempt=NEVER;return;}
                if(code==='jev_authentication_failed'||code==='jev_credential_missing'||code==='worker_stopped'||code==='scan_policy_changed'||code==='administrator_required'||code==='not_a_guild_member') {s.status='paused';s.nextAttempt=NEVER;return;}
                if(/network|jev_http_5|attachment_download_failed|internal_error/.test(code)&&++s.retries<3) {s.status='throttled';s.nextAttempt=Date.now()+1000*2**s.retries+Math.floor(Math.random()*500);return;}
                s.counters.failed++;if(s.failures.length<100)s.failures.push({reason:code,channel:channel.id,...(s.pending?{message:s.pending.message}:{})});
                if(/permission|discord_http_403/.test(code)||!s.pending) {s.channels[index]!.status='failed';s.channels[index]!.reason=code;s.pending=null;s.channelIndex++;}
                else {s.counters.skipped++;s.pending.index++;s.pending.imageReserved=false;}
                s.retries=0;
            });
        }
        return true;
    }
}
