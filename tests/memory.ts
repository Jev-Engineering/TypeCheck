import { MemoryAnalytics } from './memory-analytics.js';
import { randomUUID } from 'node:crypto';
import { assert, DEFAULT_SETTINGS, type Settings, type Kind, type RecordBase, type Job, type ImageMessage, type Session, type ReferenceImage, type Rule } from '../shared/domain.js';
import { digest } from '../server/security.js';
import type { Store, SettingsVersion, Usage, ActionRecord } from '../server/store.js';
const clone = <T>(v: T): T => structuredClone(v);
export class MemoryStore implements Store {
    readonly analytics: MemoryAnalytics = new MemoryAnalytics(this);
    private state = { settings: new Map<string, SettingsVersion>(), records: new Map<string, RecordBase>(), jobs: new Map<string, Job>(), seen: new Set<string>(), actions: new Map<string, ActionRecord>(), usage: new Map<string, Usage>(), nonces: new Map<string, {
            origin: string;
            expires: number;
        }>(), sessions: new Map<string, Session>() };
    private tail: Promise<unknown> = Promise.resolve();
    async getSettings(g: string) { if (!this.state.settings.has(g))
        this.state.settings.set(g, { value: clone(DEFAULT_SETTINGS), revision: 1 }); return clone(this.state.settings.get(g)!); }
    async putSettings(g: string, value: Settings, revision: number) { const old = await this.getSettings(g); assert(old.revision === revision, 'revision_conflict', 409); this.state.settings.set(g, { value: clone(value), revision: revision + 1 }); }
    async guilds() { return [...this.state.settings.keys()]; }
    async all<T extends RecordBase>(k: Kind, g: string): Promise<T[]> { return clone([...this.state.records].filter(([key]) => key.startsWith(g + ':' + k + ':')).map(([, r]) => r as T).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
    async get<T extends RecordBase>(k: Kind, g: string, id: string): Promise<T | null> { return clone(this.state.records.get(`${g}:${k}:${id}`) as T ?? null); }
    async put<T extends RecordBase>(k: Kind, r: T, revision: number) {
        const old = await this.get(k, r.guildId, r.id);
        assert((old?.revision ?? 0) === revision && r.revision === revision + 1, 'revision_conflict', 409);
        const d = r as T & {
            groupId?: string | null;
            referenceId?: string | null;
        };
        if (d.groupId)
            assert(await this.get('groups', r.guildId, d.groupId), 'reference_in_use_or_wrong_guild', 409);
        if (d.referenceId)
            assert(await this.get('images', r.guildId, d.referenceId), 'reference_in_use_or_wrong_guild', 409);
        this.state.records.set(`${r.guildId}:${k}:${r.id}`, clone(r));
    }
    async remove(k: Kind, g: string, id: string, revision: number) {
        const old = await this.get(k, g, id);
        assert(old?.revision === revision, 'revision_conflict', 409);
        if (k === 'images')
            assert(!(await this.all<Rule>('rules', g)).some(r => r.referenceId === id), 'record_in_use', 409);
        if (k === 'groups')
            assert(!(await this.all<ReferenceImage>('images', g)).some(r => r.groupId === id) && !(await this.all<Rule>('rules', g)).some(r => r.groupId === id), 'record_in_use', 409);
        this.state.records.delete(`${g}:${k}:${id}`);
    }
    async withGuild<T>(_g: string, work: (s: Store) => Promise<T>): Promise<T> { const run = async () => { const before = clone(this.state), records = clone(this.analytics.records), history = clone(this.analytics.history); try {
        return await work(this);
    }
    catch (e) {
        this.state = before; this.analytics.records = records; this.analytics.history = history;
        throw e;
    } }; const result = this.tail.then(run, run); this.tail = result.catch(() => { }); return result; }
    async enqueue(message: ImageMessage) { const signature = digest(message.attachments.map(a => a.id).sort().join(',')); if ([...this.state.jobs.values()].some(j => j.guildId === message.guildId && j.message.messageId === message.messageId && j.signature === signature))
        return false; const job: Job = { id: randomUUID(), guildId: message.guildId, message: clone(message), signature, status: 'queued', error: null, createdAt: new Date().toISOString() }; this.state.jobs.set(job.id, job); return true; }
    async claim() { const job = [...this.state.jobs.values()].find(j => j.status === 'queued'); if (job)
        job.status = 'processing'; return job ? clone(job) : null; }
    async finish(id: string, error: string | null) { const j = this.state.jobs.get(id)!; j.status = error ? 'failed' : 'done'; j.error = error; }
    async seen(g: string, m: string, a: string) { return this.state.seen.has(`${g}:${m}:${a}`); }
    async markSeen(g: string, m: string, a: string) { this.state.seen.add(`${g}:${m}:${a}`); }
    async beginAction(r: ActionRecord) { const key = `${r.guildId}:${r.messageId}:${r.slot}`; if (this.state.actions.has(key))
        return false; this.state.actions.set(key, clone(r)); return true; }
    async finishAction(g: string, m: string, slot: string, status: string, detail: string) { const old = this.state.actions.get(`${g}:${m}:${slot}`)!; old.status = status; old.detail = detail; }
    async actions(g: string) { return clone([...this.state.actions.values()].filter(r => r.guildId === g)); }
    async reserveCall(g: string, limit: number, day = new Date().toISOString().slice(0,10)) { const u = clone(this.state.usage.get(g+':'+day) ?? {day,calls:0,inputTokens:0}); assert(u.calls < limit, 'daily_jev_call_budget_exhausted', 429); u.calls++; this.state.usage.set(g+':'+u.day, u); }
    async addTokens(g: string, n: number, day = new Date().toISOString().slice(0,10)) { const u = clone(this.state.usage.get(g+':'+day) ?? {day,calls:0,inputTokens:0}); u.inputTokens += n; this.state.usage.set(g+':'+u.day, u); }
    async usage(g: string): Promise<Usage> { return clone(this.state.usage.get(g+':'+new Date().toISOString().slice(0,10)) ?? { day: new Date().toISOString().slice(0, 10), calls: 0, inputTokens: 0 }); }
    async createNonce(hash: string, origin: string) { this.state.nonces.set(hash, { origin, expires: Date.now() + 300000 }); }
    async consumeNonce(hash: string, origin: string) { const v = this.state.nonces.get(hash); if (v?.origin !== origin || v.expires < Date.now())
        return false; this.state.nonces.delete(hash); return true; }
    async createSession(hash: string, s: Session) { this.state.sessions.set(hash, clone(s)); }
    async session(hash: string) { const s = this.state.sessions.get(hash); return s && s.expiresAt > Date.now() ? clone(s) : null; }
    async deleteSession(hash: string) { this.state.sessions.delete(hash); }
    async maintenance() { const cutoff = new Date(Date.now()-100*86400000).toISOString().slice(0,10); for(const [key,a] of this.analytics.records) if(a.startedAt.slice(0,10)<cutoff) this.analytics.records.delete(key); for(const [key,u] of this.state.usage) if(u.day<new Date(Date.now()-400*86400000).toISOString().slice(0,10)) this.state.usage.delete(key); for (const [k, s] of this.state.sessions)
        if (s.expiresAt < Date.now())
            this.state.sessions.delete(k); }
}
