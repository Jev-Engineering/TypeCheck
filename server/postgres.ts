import { SqlAnalytics } from './usage-sql.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, AppError, assert, type RecordBase, type Kind, type Settings, type ImageMessage, type Job, type Session } from '../shared/domain.js';
import { digest } from './security.js';
import type { Store, SettingsVersion, Usage, ActionRecord } from './store.js';
export interface QueryResult {
    rows: any[];
    rowCount: number | null;
}
export interface SqlClient {
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
    release?(): void;
    on?(event: string, listener: () => void): unknown;
    removeListener?(event: string, listener: () => void): unknown;
}
export interface SqlPool extends SqlClient {
    connect(): Promise<SqlClient>;
    end(): Promise<void>;
}
const TABLES: Record<Kind, string> = { groups: 'image_groups', images: 'reference_images', rules: 'moderation_rules', grants: 'role_grants', credentials: 'guild_credentials', calibrations: 'calibration_trials', evaluations: 'image_evaluations', events: 'moderation_events', audit: 'audit_events' };
export async function openPool(connectionString: string): Promise<SqlPool> {
    const driverName = 'pg';
    const { Pool } = await import(driverName);
    return new Pool({ connectionString, max: 8, connectionTimeoutMillis: 10000, statement_timeout: 30000 }) as SqlPool;
}
export class PostgresStore implements Store {
    constructor(readonly pool: SqlPool, private connection?: SqlClient, private defaultModel = DEFAULT_SETTINGS.model) { }
    get analytics(): SqlAnalytics { return new SqlAnalytics(this, (sql, values) => this.query(sql, values), 'postgres'); }
    private query(sql: string, values?: unknown[]) { return (this.connection ?? this.pool).query(sql, values); }
    async getSettings(guild: string): Promise<SettingsVersion> {
        await this.query('INSERT INTO guilds(id,settings) VALUES($1,$2) ON CONFLICT DO NOTHING', [guild, { ...DEFAULT_SETTINGS, model: this.defaultModel }]);
        const r = (await this.query('SELECT settings,revision FROM guilds WHERE id=$1', [guild])).rows[0];
        return { value: r.settings, revision: r.revision };
    }
    async putSettings(guild: string, value: Settings, revision: number) { const r = await this.query('UPDATE guilds SET settings=$2,revision=revision+1 WHERE id=$1 AND revision=$3', [guild, value, revision]); assert(r.rowCount === 1, 'revision_conflict', 409); }
    async guilds() { return (await this.query('SELECT id FROM guilds ORDER BY id')).rows.map(r => r.id as string); }
    async all<T extends RecordBase>(kind: Kind, guild: string): Promise<T[]> { return (await this.query(`SELECT data FROM ${TABLES[kind]} WHERE guild_id=$1 ORDER BY updated_at DESC,id`, [guild])).rows.map(r => r.data as T); }
    async get<T extends RecordBase>(kind: Kind, guild: string, id: string): Promise<T | null> { const r = (await this.query(`SELECT data FROM ${TABLES[kind]} WHERE guild_id=$1 AND id=$2`, [guild, id])).rows[0]; return r?.data ?? null; }
    async put<T extends RecordBase>(kind: Kind, record: T, expected: number) {
        assert(record.revision === expected + 1, 'invalid_revision');
        const table = TABLES[kind];
        const values: unknown[] = [record.guildId, record.id, record, record.revision];
        let extraColumns = '', extraValues = '', extraSet = '';
        const data = record as T & {
            groupId?: string | null;
            referenceId?: string | null;
        };
        if (kind === 'images' || kind === 'rules') {
            values.push(data.groupId ?? null);
            extraColumns += ',group_id';
            extraValues += ',$5';
            extraSet += ',group_id=$5';
        }
        if (kind === 'rules') {
            values.push(data.referenceId ?? null);
            extraColumns += ',reference_id';
            extraValues += ',$6';
            extraSet += ',reference_id=$6';
        }
        try {
            if (expected === 0)
                await this.query(`INSERT INTO ${table}(guild_id,id,data,revision${extraColumns}) VALUES($1,$2,$3,$4${extraValues})`, values);
            else {
                values.push(expected);
                const r = await this.query(`UPDATE ${table} SET data=$3,revision=$4,updated_at=now()${extraSet} WHERE guild_id=$1 AND id=$2 AND revision=$${values.length}`, values);
                assert(r.rowCount === 1, 'revision_conflict', 409);
            }
        }
        catch (e) {
            if ((e as {
                code?: string;
            }).code === '23505')
                throw new AppError('duplicate_record', 409);
            if ((e as {
                code?: string;
            }).code === '23503')
                throw new AppError('reference_in_use_or_wrong_guild', 409);
            throw e;
        }
    }
    async remove(kind: Kind, guild: string, id: string, revision: number) {
        try {
            const r = await this.query(`DELETE FROM ${TABLES[kind]} WHERE guild_id=$1 AND id=$2 AND revision=$3`, [guild, id, revision]);
            assert(r.rowCount === 1, 'revision_conflict', 409);
        }
        catch (e) {
            if ((e as {
                code?: string;
            }).code === '23503')
                throw new AppError('record_in_use', 409);
            throw e;
        }
    }
    async withGuild<T>(guild: string, work: (s: Store) => Promise<T>): Promise<T> {
        if (this.connection)
            return work(this);
        const c = await this.pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [guild]);
            const r = await work(new PostgresStore(this.pool, c, this.defaultModel));
            await c.query('COMMIT');
            return r;
        }
        catch (e) {
            await c.query('ROLLBACK');
            throw e;
        }
        finally {
            c.release?.();
        }
    }
    async enqueue(message: ImageMessage) {
        await this.getSettings(message.guildId);
        const queued = await this.query("SELECT count(*)::integer AS n FROM jobs WHERE guild_id=$1 AND status IN ('queued','processing')", [message.guildId]);
        assert(queued.rows[0].n < 1000, 'guild_queue_limit', 429);
        const sig = digest(message.attachments.map(a => a.id).sort().join(','));
        const r = await this.query('INSERT INTO jobs(id,guild_id,message,message_id,signature) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [randomUUID(), message.guildId, message, message.messageId, sig]);
        return r.rowCount === 1;
    }
    async claim(): Promise<Job | null> {
        const r = (await this.query("WITH q AS (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET status='processing',updated_at=now() FROM q WHERE jobs.id=q.id RETURNING jobs.*")).rows[0];
        return r ? { id: r.id, guildId: r.guild_id, message: r.message, signature: r.signature, status: r.status, error: r.error, createdAt: r.created_at.toISOString() } : null;
    }
    async finish(id: string, error: string | null) { await this.query("UPDATE jobs SET status=$2,error=$3,message='{}'::jsonb,updated_at=now() WHERE id=$1", [id, error ? 'failed' : 'done', error]); }
    async seen(guild: string, message: string, attachment: string) { return (await this.query('SELECT 1 FROM seen_attachments WHERE guild_id=$1 AND message_id=$2 AND attachment_id=$3', [guild, message, attachment])).rowCount === 1; }
    async markSeen(guild: string, message: string, attachment: string) { await this.query('INSERT INTO seen_attachments VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [guild, message, attachment]); }
    async beginAction(r: ActionRecord) { const q = await this.query('INSERT INTO action_ledger(guild_id,message_id,slot,action,status,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [r.guildId, r.messageId, r.slot, r.action, r.status, r.detail]); return q.rowCount === 1; }
    async finishAction(guild: string, message: string, slot: string, status: string, detail: string) { await this.query('UPDATE action_ledger SET status=$4,detail=$5 WHERE guild_id=$1 AND message_id=$2 AND slot=$3', [guild, message, slot, status, detail]); }
    async actions(guild: string): Promise<ActionRecord[]> { return (await this.query('SELECT * FROM action_ledger WHERE guild_id=$1 ORDER BY created_at DESC', [guild])).rows.map(r => ({ guildId: r.guild_id, messageId: r.message_id, slot: r.slot, action: r.action, status: r.status, detail: r.detail, createdAt: r.created_at.toISOString() })); }
    async reserveCall(guild: string, limit: number, day = new Date().toISOString().slice(0,10)) { const r = await this.query("INSERT INTO usage_daily(guild_id,day,calls) VALUES($1,$3::date,1) ON CONFLICT(guild_id,day) DO UPDATE SET calls=usage_daily.calls+1 WHERE usage_daily.calls<$2 RETURNING calls", [guild, limit, day]); assert(r.rowCount === 1, 'daily_jev_call_budget_exhausted', 429); }
    async addTokens(guild: string, n: number, day = new Date().toISOString().slice(0,10)) { await this.query("UPDATE usage_daily SET input_tokens=input_tokens+$2 WHERE guild_id=$1 AND day=$3::date", [guild, n, day]); }
    async usage(guild: string): Promise<Usage> { const r = (await this.query("SELECT day::text,calls,input_tokens::text FROM usage_daily WHERE guild_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date", [guild])).rows[0]; return r ? { day: r.day, calls: r.calls, inputTokens: Number(r.input_tokens) } : { day: new Date().toISOString().slice(0, 10), calls: 0, inputTokens: 0 }; }
    async createNonce(hash: string, origin: string) { await this.query("INSERT INTO auth_nonces VALUES($1,$2,now()+interval '5 minutes')", [hash, origin]); }
    async consumeNonce(hash: string, origin: string) { return (await this.query('DELETE FROM auth_nonces WHERE hash=$1 AND origin=$2 AND expires_at>now() RETURNING hash', [hash, origin])).rowCount === 1; }
    async createSession(hash: string, s: Session) { await this.query('INSERT INTO sessions VALUES($1,$2,$3,to_timestamp($4/1000.0))', [hash, s.userId, s.guildId, s.expiresAt]); }
    async session(hash: string): Promise<Session | null> { const r = (await this.query('SELECT * FROM sessions WHERE hash=$1 AND expires_at>now()', [hash])).rows[0]; return r ? { userId: r.user_id, guildId: r.guild_id, expiresAt: r.expires_at.getTime() } : null; }
    async deleteSession(hash: string) { await this.query('DELETE FROM sessions WHERE hash=$1', [hash]); }
    async maintenance() {
        await this.analytics.cleanup();
        await this.query('DELETE FROM auth_nonces WHERE expires_at<now()');
        await this.query('DELETE FROM sessions WHERE expires_at<now()');
        await this.query("DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at<now()-interval '7 days'");
        for (const kind of ['evaluations', 'events', 'audit', 'calibrations'] as Kind[])
            await this.query(`DELETE FROM ${TABLES[kind]} r USING guilds g WHERE r.guild_id=g.id AND r.updated_at<now()-make_interval(days=>(g.settings->>'logRetentionDays')::integer)`);
    }
    async acquireLeader(onLost: () => void = () => { }): Promise<(() => Promise<void>) | null> {
        const c = await this.pool.connect();
        const r = await c.query('SELECT pg_try_advisory_lock(21474199,1) AS locked');
        if (!r.rows[0].locked) {
            c.release?.();
            return null;
        }
        c.on?.('error', onLost);
        c.on?.('end', onLost);
        // Only the elected worker resets interrupted jobs. Action tombstones never reset.
        await c.query("UPDATE jobs SET status='queued',updated_at=now() WHERE status='processing'");
        await c.query("UPDATE action_ledger SET status='unknown',detail='process_interrupted_do_not_replay' WHERE status='attempting'");
        return async () => { c.removeListener?.('error', onLost); c.removeListener?.('end', onLost); await c.query('SELECT pg_advisory_unlock(21474199,1)'); c.release?.(); };
    }
}
