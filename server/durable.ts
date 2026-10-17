import type { SqlPool } from './postgres.js';
export interface DurableRow { id: string; guild: string | null; kind: string; due: number; data: any }
export interface DurableStore {
    activeScans(guild: string): Promise<number>;
    get(id: string): Promise<DurableRow | null>;
    list(kind: string, guild: string | null, due: number, limit: number): Promise<DurableRow[]>;
    change<T>(id: string, initial: DurableRow, update: (row: DurableRow) => T): Promise<T>;
}
// Short row transactions only: no network I/O or provider calls under this lock.
export class SqlDurable implements DurableStore {
    constructor(private pool: SqlPool, private mysql: boolean) {}
    private sql(s: string) { let n = 0; return this.mysql ? s : s.replaceAll('?', () => '$' + ++n); }
    private row(r: any): DurableRow { return { id: r.id, guild: r.guild_id, kind: r.kind, due: Number(r.due), data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }; }
    async activeScans(guild: string) {
        const status=this.mysql?"JSON_UNQUOTE(JSON_EXTRACT(data,'$.status'))":"data->>'status'";
        return Number((await this.pool.query(this.sql(`SELECT COUNT(*) AS n FROM durable_work WHERE guild_id=? AND kind='scan' AND ${status} NOT IN ('completed','completed_with_gaps','cancelled','failed')`),[guild])).rows[0].n);
    }
    async get(id: string) { const r = (await this.pool.query(this.sql('SELECT * FROM durable_work WHERE id=?'), [id])).rows[0]; return r ? this.row(r) : null; }
    async list(kind: string, guild: string | null, due: number, limit: number) {
        const rows = await this.pool.query(this.sql(`SELECT * FROM durable_work WHERE kind=? AND due<=? ${guild === null ? '' : 'AND guild_id=?'} ORDER BY due,id LIMIT ${Math.min(100, Math.max(1, Math.floor(limit)))}`), [kind, due, ...(guild === null ? [] : [guild])]);
        return rows.rows.map(r => this.row(r));
    }
    async change<T>(id: string, initial: DurableRow, update: (row: DurableRow) => T): Promise<T> {
        const c = await this.pool.connect();
        try {
            await c.query('BEGIN');
            await c.query(this.sql('INSERT INTO durable_work(id,guild_id,kind,due,data) VALUES(?,?,?,?,?) ' + (this.mysql ? 'ON DUPLICATE KEY UPDATE id=id' : 'ON CONFLICT DO NOTHING')), [id, initial.guild, initial.kind, initial.due, JSON.stringify(initial.data)]);
            const row = this.row((await c.query(this.sql('SELECT * FROM durable_work WHERE id=? FOR UPDATE'), [id])).rows[0]);
            const result = update(row);
            await c.query(this.sql('UPDATE durable_work SET due=?,data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'), [row.due, JSON.stringify(row.data), id]);
            await c.query('COMMIT'); return result;
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release?.(); }
    }
}
export class MemoryDurable implements DurableStore {
    rows = new Map<string, DurableRow>();
    async activeScans(guild: string) { return [...this.rows.values()].filter(r=>r.guild===guild&&r.kind==='scan'&&!['completed','completed_with_gaps','cancelled','failed'].includes(r.data.status)).length; }
    async get(id: string) { return structuredClone(this.rows.get(id) ?? null); }
    async list(kind: string, guild: string | null, due: number, limit: number) { return structuredClone([...this.rows.values()].filter(r => r.kind === kind && (guild === null || r.guild === guild) && r.due <= due).sort((a,b) => a.due - b.due || a.id.localeCompare(b.id)).slice(0,limit)); }
    async change<T>(id: string, initial: DurableRow, update: (row: DurableRow) => T) { const r = structuredClone(this.rows.get(id) ?? initial); const result = update(r); this.rows.set(id,r); return result; }
}
