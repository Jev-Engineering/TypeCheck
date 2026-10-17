import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../shared/domain.js';
import type { DurableStore } from './durable.js';
export class Deferred extends AppError {
    constructor(readonly until: number, code = 'rate_limit_deferred') { super(code, 503); }
}
export const scopeHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function retryAt(headers: Headers, bodySeconds?: unknown, now = Date.now(), fallback = 1000): number {
    const h = headers.get('retry-after');
    const seconds = h !== null && h.trim() !== '' ? Number(h) : NaN;
    const date = h && !Number.isFinite(seconds) ? Date.parse(h) : NaN;
    const ms = Number(headers.get('retry-after-ms'));
    const body = typeof bodySeconds === 'number' && Number.isFinite(bodySeconds) ? bodySeconds * 1000 : 0;
    return Math.ceil(Math.min(8640000000000000, now + Math.max(fallback, Number.isFinite(ms)?ms:0, Number.isFinite(seconds) ? seconds * 1000 : 0, Number.isFinite(date) ? date - now : 0, body)));
}
export class Throttle {
    constructor(readonly store: DurableStore, readonly now = Date.now) {}
    private initial(key: string) { return {id:'rate:'+key,guild:null,kind:'rate',due:0,data:{}}; }
    async check(key: string) { const row = await this.store.get('rate:'+key); if (row && row.due > this.now()) throw new Deferred(row.due); }
    async delay(key: string, until: number) { const row=this.initial(key); await this.store.change(row.id,row,r=>{r.due=Math.max(r.due,Math.ceil(Math.min(8640000000000000,Number.isFinite(until)?until:8640000000000000)));}); }
    async enter(key: string, spacing: number, lease = 30000) {
        const row = this.initial(key), now = this.now(), owner=randomUUID();
        const until = await this.store.change(row.id,row,r=>{
            if(r.due>now) return r.due;
            // A busy slot may finish quickly. Recheck on a bounded later turn rather
            // than delaying live work for the full crash-recovery lease duration.
            if((r.data.lease??0)>now) return Math.min(r.data.lease,now+250);
            r.data.owner=owner; r.data.lease=now+lease; r.due=now+spacing; return 0;
        });
        if(until) throw new Deferred(until);
        return async () => { await this.store.change(row.id,row,r=>{if(r.data.owner===owner)r.data.lease=0;}); };
    }
    async backoff(key: string) {
        const row=this.initial(key);
        return this.store.change(row.id,row,r=>{r.data.failures=Math.min(8,(r.data.failures??0)+1);return 500*2**(r.data.failures-1)+Math.floor(Math.random()*250);});
    }
    async healthy(key: string) { const row=this.initial(key); await this.store.change(row.id,row,r=>{r.data.failures=0;}); }
    async bucket(route: string) { return (await this.store.get('bucket:'+route))?.data.key as string | undefined; }
    async bind(route: string, key: string) { const id='bucket:'+route; await this.store.change(id,{id,guild:null,kind:'bucket',due:0,data:{}},r=>{r.data.key=key;}); }
}
