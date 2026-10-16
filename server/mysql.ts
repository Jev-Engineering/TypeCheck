import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, AppError, assert, type RecordBase, type Kind, type Settings, type ImageMessage, type Job, type Session } from '../shared/domain.js';
import { digest } from './security.js';
import type { Store, SettingsVersion, Usage, ActionRecord } from './store.js';
import type { SqlClient } from './postgres.js';
import type { MySqlPool } from './mysql-pool.js';
export { openMySqlPool } from './mysql-pool.js';
const TABLES: Record<Kind, string> = { groups: 'image_groups', images: 'reference_images', rules: 'moderation_rules', grants: 'role_grants', credentials: 'guild_credentials', calibrations: 'calibration_trials', evaluations: 'image_evaluations', events: 'moderation_events', audit: 'audit_events' };
export class MySqlStore implements Store {
    constructor(readonly pool: MySqlPool, private connection?: SqlClient, private defaultModel = DEFAULT_SETTINGS.model) { }
    private query(sql: string, values?: unknown[]) { return (this.connection ?? this.pool).query(sql, values); }
    async getSettings(guild: string): Promise<SettingsVersion> {
        await this.query('INSERT INTO guilds(id,settings) VALUES(?,?) ON DUPLICATE KEY UPDATE id=id', [guild, JSON.stringify({ ...DEFAULT_SETTINGS, model: this.defaultModel })]);
        const r = (await this.query('SELECT settings,revision FROM guilds WHERE id=?', [guild])).rows[0];
        return { value: r.settings, revision: r.revision };
    }
    async putSettings(guild: string, value: Settings, revision: number) { const r = await this.query('UPDATE guilds SET settings=?,revision=revision+1 WHERE id=? AND revision=?', [JSON.stringify(value), guild, revision]); assert(r.rowCount === 1, 'revision_conflict', 409); }
    async guilds() { return (await this.query('SELECT id FROM guilds ORDER BY id')).rows.map(r => r.id as string); }
    async all<T extends RecordBase>(kind: Kind, guild: string): Promise<T[]> { return (await this.query(`SELECT data FROM ${TABLES[kind]} WHERE guild_id=? ORDER BY updated_at DESC,id`, [guild])).rows.map(r => r.data as T); }
    async get<T extends RecordBase>(kind: Kind, guild: string, id: string): Promise<T | null> { const r = (await this.query(`SELECT data FROM ${TABLES[kind]} WHERE guild_id=? AND id=?`, [guild, id])).rows[0]; return r?.data ?? null; }
    async put<T extends RecordBase>(kind: Kind, record: T, expected: number) {
        assert(record.revision === expected + 1, 'invalid_revision');
        const table = TABLES[kind];
        const values: unknown[] = [record.guildId, record.id, JSON.stringify(record), record.revision];
        let extraColumns = '', extraValues = '', extraSet = '';
        const data = record as T & {
            groupId?: string | null;
            referenceId?: string | null;
        };
        if (kind === 'images' || kind === 'rules') {
            values.push(data.groupId ?? null);
            extraColumns += ',group_id';
            extraValues += ',?';
            extraSet += ',group_id=?';
        }
        if (kind === 'rules') {
            values.push(data.referenceId ?? null);
            extraColumns += ',reference_id';
            extraValues += ',?';
            extraSet += ',reference_id=?';
        }
        try {
            if (expected === 0)
                await this.query(`INSERT INTO ${table}(guild_id,id,data,revision${extraColumns}) VALUES(?,?,?,?${extraValues})`, values);
            else {
                const updateValues = [...values.slice(2), record.guildId, record.id, expected];
                const r = await this.query(`UPDATE ${table} SET data=?,revision=?,updated_at=NOW(3)${extraSet} WHERE guild_id=? AND id=? AND revision=?`, updateValues);
                assert(r.rowCount === 1, 'revision_conflict', 409);
            }
        }
        catch (e) {
            if ((e as {
                code?: string;
            }).code === 'ER_DUP_ENTRY')
                throw new AppError('duplicate_record', 409);
            if ((e as {
                code?: string;
            }).code?.match(/^ER_(ROW_IS_REFERENCED_2|NO_REFERENCED_ROW_2)$/))
                throw new AppError('reference_in_use_or_wrong_guild', 409);
            throw e;
        }
    }
    async remove(kind: Kind, guild: string, id: string, revision: number) {
        try {
            const r = await this.query(`DELETE FROM ${TABLES[kind]} WHERE guild_id=? AND id=? AND revision=?`, [guild, id, revision]);
            assert(r.rowCount === 1, 'revision_conflict', 409);
        }
        catch (e) {
            if ((e as {
                code?: string;
            }).code?.match(/^ER_(ROW_IS_REFERENCED_2|NO_REFERENCED_ROW_2)$/))
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
            const tx = new MySqlStore(this.pool, c, this.defaultModel);
            await tx.getSettings(guild);
            await c.query('SELECT id FROM guilds WHERE id=? FOR UPDATE', [guild]);
            const r = await work(new MySqlStore(this.pool, c, this.defaultModel));
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
        const queued = await this.query("SELECT COUNT(*) AS n FROM jobs WHERE guild_id=? AND status IN ('queued','processing')", [message.guildId]);
        assert(Number(queued.rows[0].n) < 1000, 'guild_queue_limit', 429);
        const sig = digest(message.attachments.map(a => a.id).sort().join(','));
        const r = await this.query('INSERT INTO jobs(id,guild_id,message,message_id,signature) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [randomUUID(), message.guildId, JSON.stringify(message), message.messageId, sig]);
        return r.rowCount === 1;
    }
    async claim(): Promise<Job | null> {
        const c = await this.pool.connect();
        try {
            await c.query('BEGIN');
            const selected = (await c.query("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
            if (!selected) { await c.query('COMMIT'); return null; }
            await c.query("UPDATE jobs SET status='processing',updated_at=NOW(3) WHERE id=?", [selected.id]);
            const r = (await c.query('SELECT * FROM jobs WHERE id=?', [selected.id])).rows[0];
            await c.query('COMMIT');
            return { id: r.id, guildId: r.guild_id, message: r.message, signature: r.signature, status: r.status, error: r.error, createdAt: r.created_at.toISOString() };
        } catch (e) { await c.query('ROLLBACK'); throw e; }
        finally { c.release?.(); }
    }
    async finish(id: string, error: string | null) { await this.query("UPDATE jobs SET status=?,error=?,message=JSON_OBJECT(),updated_at=NOW(3) WHERE id=?", [error ? 'failed' : 'done', error, id]); }
    async seen(guild: string, message: string, attachment: string) { return (await this.query('SELECT 1 FROM seen_attachments WHERE guild_id=? AND message_id=? AND attachment_id=?', [guild, message, attachment])).rowCount === 1; }
    async markSeen(guild: string, message: string, attachment: string) { await this.query('INSERT INTO seen_attachments VALUES(?,?,?) ON DUPLICATE KEY UPDATE guild_id=guild_id', [guild, message, attachment]); }
    async beginAction(r: ActionRecord) { const q = await this.query('INSERT INTO action_ledger(guild_id,message_id,slot,action,status,detail) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE guild_id=guild_id', [r.guildId, r.messageId, r.slot, r.action, r.status, r.detail]); return q.rowCount === 1; }
    async finishAction(guild: string, message: string, slot: string, status: string, detail: string) { await this.query('UPDATE action_ledger SET status=?,detail=? WHERE guild_id=? AND message_id=? AND slot=?', [status, detail, guild, message, slot]); }
    async actions(guild: string): Promise<ActionRecord[]> { return (await this.query('SELECT * FROM action_ledger WHERE guild_id=? ORDER BY created_at DESC', [guild])).rows.map(r => ({ guildId: r.guild_id, messageId: r.message_id, slot: r.slot, action: r.action, status: r.status, detail: r.detail, createdAt: r.created_at.toISOString() })); }
    async reserveCall(guild: string, limit: number) { const r = await this.query("INSERT INTO usage_daily(guild_id,day,calls) VALUES(?,UTC_DATE(),1) ON DUPLICATE KEY UPDATE calls=IF(calls<?,calls+1,calls)", [guild, limit]); assert(r.rowCount === 1 || r.rowCount === 2, 'daily_jev_call_budget_exhausted', 429); }
    async addTokens(guild: string, n: number) { await this.query("UPDATE usage_daily SET input_tokens=input_tokens+? WHERE guild_id=? AND day=UTC_DATE()", [n, guild]); }
    async usage(guild: string): Promise<Usage> { const r = (await this.query("SELECT CAST(day AS CHAR) AS day,calls,CAST(input_tokens AS CHAR) AS input_tokens FROM usage_daily WHERE guild_id=? AND day=UTC_DATE()", [guild])).rows[0]; return r ? { day: r.day, calls: r.calls, inputTokens: Number(r.input_tokens) } : { day: new Date().toISOString().slice(0, 10), calls: 0, inputTokens: 0 }; }
    async createNonce(hash: string, origin: string) { await this.query("INSERT INTO auth_nonces VALUES(?,?,NOW(3)+INTERVAL 5 MINUTE)", [hash, origin]); }
    async consumeNonce(hash: string, origin: string) { return (await this.query('DELETE FROM auth_nonces WHERE hash=? AND origin=? AND expires_at>NOW(3)', [hash, origin])).rowCount === 1; }
    async createSession(hash: string, s: Session) { await this.query('INSERT INTO sessions VALUES(?,?,?,FROM_UNIXTIME(?/1000))', [hash, s.userId, s.guildId, s.expiresAt]); }
    async session(hash: string): Promise<Session | null> { const r = (await this.query('SELECT * FROM sessions WHERE hash=? AND expires_at>NOW(3)', [hash])).rows[0]; return r ? { userId: r.user_id, guildId: r.guild_id, expiresAt: r.expires_at.getTime() } : null; }
    async deleteSession(hash: string) { await this.query('DELETE FROM sessions WHERE hash=?', [hash]); }
    async maintenance() {
        await this.query('DELETE FROM auth_nonces WHERE expires_at<NOW(3)');
        await this.query('DELETE FROM sessions WHERE expires_at<NOW(3)');
        await this.query("DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at<NOW(3)-INTERVAL 7 DAY");
        for (const kind of ['evaluations', 'events', 'audit', 'calibrations'] as Kind[])
            await this.query(`DELETE r FROM ${TABLES[kind]} r JOIN guilds g ON r.guild_id=g.id WHERE r.updated_at<NOW(3)-INTERVAL CAST(JSON_UNQUOTE(JSON_EXTRACT(g.settings,'$.logRetentionDays')) AS UNSIGNED) DAY`);
    }
    async acquireLeader(onLost: () => void = () => { }): Promise<(() => Promise<void>) | null> {
        const c = await this.pool.connect();
        let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
        const lost = () => {
            if (closed) return;
            closed = true; clearTimeout(timer);
            // Stop the controller synchronously before disposing of its lock connection.
            try { onLost(); } finally { c.destroy(); }
        };
        const heartbeat = async () => {
            try {
                const r = (await c.query("SELECT IS_USED_LOCK('typecheck:leader')=CONNECTION_ID() AS owned")).rows[0];
                if (Number(r.owned) !== 1) { lost(); return; }
                if (!closed) { timer = setTimeout(() => void heartbeat(), 5000); timer.unref(); }
            } catch { lost(); }
        };
        try {
            const r = await c.query("SELECT GET_LOCK('typecheck:leader',0) AS locked");
            if (Number(r.rows[0].locked) !== 1) { c.destroy(); return null; }
            c.on?.('error', lost); c.on?.('end', lost);
            // Bound idle disconnect exposure even on hosts with a short default wait_timeout.
            await c.query('SET SESSION wait_timeout=120');
            await c.query("UPDATE jobs SET status='queued',updated_at=NOW(3) WHERE status='processing'");
            await c.query("UPDATE action_ledger SET status='unknown',detail='process_interrupted_do_not_replay' WHERE status='attempting'");
            assert(!closed, 'worker_leadership_lost');
            timer = setTimeout(() => void heartbeat(), 5000); timer.unref();
            return async () => {
                if (closed) return;
                closed = true; clearTimeout(timer);
                c.removeListener?.('error', lost); c.removeListener?.('end', lost);
                try { await c.query("SELECT RELEASE_LOCK('typecheck:leader')"); } finally { c.destroy(); }
            };
        } catch (e) {
            closed = true; clearTimeout(timer);
            c.removeListener?.('error', lost); c.removeListener?.('end', lost); c.destroy(); throw e;
        }
    }
}
