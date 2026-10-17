import { assert } from '../shared/domain.js';
import { estimate, type AnalyticsStore, type AnalyticsQuery, type AnalyticsReport, type Attempt, type Completion, type Rate, type Bucket } from '../shared/analytics.js';
import type { Store } from './store.js';
import type { QueryResult } from './postgres.js';

/** Identical SQL/transaction semantics for both stores; only placeholders and upserts differ. */
export class SqlAnalytics implements AnalyticsStore {
    constructor(private store: Store, private raw: (sql: string, values?: unknown[]) => Promise<QueryResult>, private kind: 'postgres' | 'mysql') {}
    private query(sql: string, values: unknown[] = []) { let n = 0; return this.raw(this.kind === 'postgres' ? sql.replace(/\?/g, () => `$${++n}`) : sql, values); }
    async rates(guild: string): Promise<Rate[]> {
        return (await this.query('SELECT r.data FROM usage_rates r WHERE guild_id=? AND revision=(SELECT MAX(s.revision) FROM usage_rates s WHERE s.guild_id=r.guild_id AND s.model=r.model) ORDER BY model LIMIT 100', [guild])).rows.map(r => r.data);
    }
    async putRate(guild: string, rate: Rate) {
        // Caller holds the guild transaction so pricing and audit commit together.
        const current = (await this.query('SELECT MAX(revision) AS revision FROM usage_rates WHERE guild_id=? AND model=?', [guild, rate.model])).rows[0];
        assert(Number(current.revision ?? 0) === rate.revision, 'revision_conflict', 409);
        assert(rate.revision > 0 || (await this.rates(guild)).length < 100, 'pricing_model_limit');
        const value = { ...rate, revision: rate.revision + 1 };
        await this.query('INSERT INTO usage_rates(guild_id,model,revision,effective_at,data) VALUES(?,?,?,?,?)', [guild, rate.model, value.revision, rate.effectiveAt, JSON.stringify(value)]);
    }
    async reserve(attempt: Attempt, limit: number) {
        await this.store.withGuild(attempt.guildId, async tx => {
            const s = tx.analytics as SqlAnalytics;
            if ((await s.query('SELECT id FROM usage_attempts WHERE guild_id=? AND id=?', [attempt.guildId, attempt.id])).rowCount) return;
            await tx.reserveCall(attempt.guildId, limit, attempt.startedAt.slice(0,10));
            const rate = (await s.query('SELECT data FROM usage_rates WHERE guild_id=? AND model=? AND effective_at<=? ORDER BY effective_at DESC,revision DESC LIMIT 1', [attempt.guildId, attempt.model, attempt.startedAt])).rows[0]?.data ?? null;
            const a = { ...attempt, rate };
            await s.query('INSERT INTO usage_attempts(guild_id,id,started_at,day,model,purpose,verification,outcome,input_tokens,currency,cost_micros,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [a.guildId,a.id,a.startedAt,a.startedAt.slice(0,10),a.model,a.purpose,Number(a.verification),'reserved',null,rate?.currency ?? null,null,JSON.stringify(a)]);
        });
    }
    async dispatch(guild: string, id: string) {
        await this.store.withGuild(guild, async tx => {
            const s = tx.analytics as SqlAnalytics;
            const a: Attempt | undefined = (await s.query('SELECT data FROM usage_attempts WHERE guild_id=? AND id=?', [guild,id])).rows[0]?.data;
            assert(a, 'usage_attempt_missing', 503);
            if (a.outcome !== 'reserved') return;
            await s.query("UPDATE usage_attempts SET outcome='dispatching',data=? WHERE guild_id=? AND id=?", [JSON.stringify({...a,outcome:'dispatching'}),guild,id]);
        });
    }
    async finalize(guild: string, id: string, completion: Completion) {
        await this.store.withGuild(guild, async tx => {
            const s = tx.analytics as SqlAnalytics;
            const a: Attempt | undefined = (await s.query('SELECT data FROM usage_attempts WHERE guild_id=? AND id=?', [guild,id])).rows[0]?.data;
            assert(a, 'usage_attempt_missing', 503);
            // First durable terminal result wins, including on an ambiguous COMMIT/reconnect.
            if (a.completedAt) return;
            assert(a.outcome === 'dispatching', 'usage_attempt_not_dispatched', 503);
            const costMicros = estimate(completion.inputTokens, a.rate);
            const updated = { ...a, ...completion, costMicros };
            await s.query('UPDATE usage_attempts SET outcome=?,input_tokens=?,cost_micros=?,data=? WHERE guild_id=? AND id=?', [updated.outcome,updated.inputTokens,costMicros,JSON.stringify(updated),guild,id]);
            if (updated.inputTokens !== null) await s.query('UPDATE usage_daily SET input_tokens=input_tokens+? WHERE guild_id=? AND day=?', [updated.inputTokens,guild,a.startedAt.slice(0,10)]);
        });
    }
    private where(guild: string, q: AnalyticsQuery) {
        let sql = 'guild_id=? AND started_at>=? AND started_at<?'; const values: unknown[] = [guild,q.start+'T00:00:00.000Z',q.end+'T00:00:00.000Z'];
        for (const k of ['model','purpose','outcome','verification'] as const) if (q[k] !== undefined) { sql += ` AND ${k}=?`; values.push(k === 'verification' ? Number(q[k]) : q[k]); }
        if(q.correlationId) { sql += this.kind==='postgres' ? " AND data->>'correlationId'=?" : " AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.correlationId'))=?"; values.push(q.correlationId); }
        return { sql, values };
    }
    async report(guild: string, q: AnalyticsQuery): Promise<AnalyticsReport> {
        const w = this.where(guild,q), key = q.group === 'summary' ? "'all'" : q.group === 'day' ? 'day' : q.group;
        const rows = (await this.query(`SELECT ${key} AS bucket_key,currency,COUNT(*) AS attempts,
          SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successes,
          SUM(CASE WHEN outcome='failure' THEN 1 ELSE 0 END) AS failures,
          SUM(CASE WHEN outcome IN ('reserved','dispatching') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN outcome='uncertain' THEN 1 ELSE 0 END) AS uncertain,
          SUM(CASE WHEN outcome<>'reserved' THEN 1 ELSE 0 END) AS dispatched,
          SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage,
          SUM(CASE WHEN currency IS NOT NULL THEN 1 ELSE 0 END) AS priced,
          SUM(CASE WHEN cost_micros IS NOT NULL THEN 1 ELSE 0 END) AS covered,
          COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(cost_micros),0) AS cost_micros
          FROM usage_attempts WHERE ${w.sql} GROUP BY ${q.group === 'summary' ? 'currency' : key+',currency'} ORDER BY ${q.group === 'summary' ? 'currency' : key+',currency'}`, w.values)).rows;
        const buckets: Bucket[] = rows.map(r => ({key:String(r.bucket_key),currency:r.currency,attempts:Number(r.attempts),successes:Number(r.successes),failures:Number(r.failures),pending:Number(r.pending),uncertain:Number(r.uncertain),dispatched:Number(r.dispatched),unknownUsage:Number(r.unknown_usage),priced:Number(r.priced),covered:Number(r.covered),inputTokens:String(r.input_tokens),costMicros:String(r.cost_micros)}));
        const legacy = (await this.query('SELECT COALESCE(SUM(calls),0) AS calls,COALESCE(SUM(input_tokens),0) AS tokens FROM usage_legacy WHERE guild_id=? AND day>=? AND day<?', [guild,q.start,q.end])).rows[0];
        const trackingStart = (await this.query('SELECT started_at FROM usage_tracking WHERE id=1')).rows[0].started_at;
        return { partial: q.start+'T00:00:00.000Z' < trackingStart || BigInt(legacy.calls)>0n || buckets.some(b=>b.covered<b.attempts), buckets, trackingStart, legacy:{calls:String(legacy.calls),inputTokens:String(legacy.tokens)}, start:q.start,end:q.end };
    }
    async attempts(guild: string, q: AnalyticsQuery) {
        const w = this.where(guild,q);
        if (q.before) { w.sql += ' AND (started_at<? OR (started_at=? AND id<?))'; w.values.push(q.before,q.before,q.beforeId); }
        // limit is validated at API boundary and bounded here for all callers.
        assert(Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 100, 'invalid_page_limit');
        const rows = (await this.query(`SELECT data FROM usage_attempts WHERE ${w.sql} ORDER BY started_at DESC,id DESC LIMIT ${q.limit+1}`,w.values)).rows;
        const items: Attempt[] = rows.slice(0,q.limit).map(r => r.data), last = items.at(-1);
        return {items,next:rows.length > q.limit && last ? {before:last.startedAt,beforeId:last.id} : null};
    }
    async cleanup() {
        // No aggregate read/modify/write: concurrent cleanup is safe. Keep ten days of margin.
        const cutoff = new Date(Date.now()-100*86400000).toISOString().slice(0,10);
        const daily = new Date(Date.now()-400*86400000).toISOString().slice(0,10);
        await this.query('DELETE FROM usage_attempts WHERE day<?',[cutoff]);
        await this.query('DELETE FROM usage_legacy WHERE day<?',[daily]);
        await this.query('DELETE FROM usage_daily WHERE day<?',[daily]);
    }
}
