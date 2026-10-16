import { assert, object, onlyKeys, uuid, type Mode } from './domain.js';
export const PURPOSES = ['moderation', 'rule_test', 'credential_validation'] as const;
export const OUTCOMES = ['reserved', 'dispatching', 'success', 'failure', 'uncertain'] as const;
export type Purpose = typeof PURPOSES[number];
export interface Rate { model: string; revision: number; currency: string; perMillion: string; effectiveAt: string; note: string }
export interface Attempt {
    id: string; correlationId: string; guildId: string; model: string; purpose: Purpose; mode: Mode;
    verification: boolean; retry: number; startedAt: string; completedAt: string | null;
    outcome: typeof OUTCOMES[number]; error: string | null; inputTokens: number | null;
    rate: Rate | null; costMicros: string | null;
}
export interface Completion { outcome: 'success' | 'failure' | 'uncertain'; error: string | null; inputTokens: number | null; completedAt: string }
// Six decimal currency places. Round each attempt half up, then sum integers.
export function estimate(tokens: number | null, rate: Rate | null): string | null {
    if (tokens === null || !rate) return null;
    assert(Number.isSafeInteger(tokens) && tokens >= 0, 'invalid_tokens');
    const [whole, fraction = ''] = rate.perMillion.split('.');
    const micros = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    return ((BigInt(tokens) * micros + 500000n) / 1000000n).toString();
}
export function money(micros: string) { const n = BigInt(micros); return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')}`; }
export function parseRate(value: unknown): Rate {
    const v = object(value); onlyKeys(v, ['model', 'revision', 'currency', 'perMillion', 'effectiveAt', 'note']);
    assert(typeof v.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(v.model), 'invalid_model');
    assert(Number.isInteger(v.revision) && Number(v.revision) >= 0 && Number(v.revision) < 1000000000, 'invalid_revision');
    assert(typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency), 'invalid_currency');
    assert(typeof v.perMillion === 'string' && /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/.test(v.perMillion), 'invalid_price');
    assert(typeof v.effectiveAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.effectiveAt) && Number.isFinite(Date.parse(v.effectiveAt)) && new Date(v.effectiveAt).toISOString() === v.effectiveAt, 'invalid_effective_at');
    if (v.note === undefined) v.note = '';
    assert(typeof v.note === 'string' && v.note.length <= 300, 'invalid_pricing_note');
    return v as unknown as Rate;
}
export interface AnalyticsQuery { start: string; end: string; group: 'summary' | 'day' | 'model' | 'purpose' | 'verification' | 'outcome'; model?: string; purpose?: string; outcome?: string; verification?: boolean; limit: number; before?: string; beforeId?: string }
export function analyticsQuery(p: URLSearchParams, now = new Date()): AnalyticsQuery {
    const allowed = ['range', 'start', 'end', 'group', 'model', 'purpose', 'outcome', 'verification', 'limit', 'before', 'beforeId'];
    for (const k of p.keys()) assert(allowed.includes(k) && p.getAll(k).length === 1, 'invalid_analytics_parameter');
    const day = now.toISOString().slice(0, 10), midnight = Date.parse(day), endDefault = new Date(midnight + 86400000).toISOString().slice(0, 10);
    const range = p.get('range') ?? 'today';
    assert(['today','7d','30d','mtd','custom'].includes(range), 'invalid_range');
    let start = day, end = endDefault;
    if (range === 'custom') { start = p.get('start') ?? ''; end = p.get('end') ?? ''; }
    else { assert(!p.has('start') && !p.has('end'), 'custom_range_required'); if (range === '7d' || range === '30d') start = new Date(midnight - (range === '7d' ? 6 : 29) * 86400000).toISOString().slice(0,10); if (range === 'mtd') start = day.slice(0,8) + '01'; }
    for (const d of [start,end]) assert(/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d, 'invalid_date');
    assert(start < end && Date.parse(end) - Date.parse(start) <= 90 * 86400000 && end <= endDefault && Date.parse(start) >= midnight - 89 * 86400000, 'range_outside_90_day_window');
    const group = p.get('group') ?? 'summary'; assert(['summary','day','model','purpose','verification','outcome'].includes(group), 'invalid_group');
    const limit = p.get('limit') ?? '50'; assert(/^[1-9]\d*$/.test(limit) && Number(limit) <= 100, 'invalid_page_limit');
    const q: AnalyticsQuery = { start, end, group: group as AnalyticsQuery['group'], limit: Number(limit) };
    if (p.has('model')) { const m = p.get('model')!; assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m), 'invalid_model'); q.model = m; }
    if (p.has('purpose')) { assert(PURPOSES.includes(p.get('purpose') as Purpose), 'invalid_purpose'); q.purpose = p.get('purpose')!; }
    if (p.has('outcome')) { assert((OUTCOMES as readonly string[]).includes(p.get('outcome')!), 'invalid_outcome'); q.outcome = p.get('outcome')!; }
    if (p.has('verification')) { assert(['true','false'].includes(p.get('verification')!), 'invalid_verification'); q.verification = p.get('verification') === 'true'; }
    if (p.has('before') || p.has('beforeId')) { const b = p.get('before') ?? '', id = p.get('beforeId') ?? ''; assert(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(b) && Number.isFinite(Date.parse(b)) && new Date(b).toISOString() === b && uuid(id), 'invalid_cursor'); q.before = b; q.beforeId = id; }
    return q;
}
export interface Bucket { key: string; currency: string | null; attempts: number; successes: number; failures: number; pending: number; uncertain: number; dispatched: number; unknownUsage: number; priced: number; covered: number; inputTokens: string; costMicros: string }
export interface AnalyticsReport { partial: boolean; buckets: Bucket[]; trackingStart: string; legacy: { calls: string; inputTokens: string }; start: string; end: string }
export interface AnalyticsStore {
    reserve(attempt: Attempt, limit: number): Promise<void>;
    dispatch(guild: string, id: string): Promise<void>;
    finalize(guild: string, id: string, completion: Completion): Promise<void>;
    rates(guild: string): Promise<Rate[]>;
    putRate(guild: string, rate: Rate): Promise<void>;
    report(guild: string, query: AnalyticsQuery): Promise<AnalyticsReport>;
    attempts(guild: string, query: AnalyticsQuery): Promise<{ items: Attempt[]; next: { before: string; beforeId: string } | null }>;
}
