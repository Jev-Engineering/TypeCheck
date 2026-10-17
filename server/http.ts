import { TEXT_STARTERS } from '../shared/text-starters.js';
import { TEXT_LIMITS } from '../shared/text.js';
import { installTextStarters } from './text-starters.js';
import { Deferred } from './throttle.js';
import { Historical } from './historical.js';
import { seedStarterReferences } from './starter-references.js';
import { CONTENT_LIMITS, CONTENT_PRESETS, parseContent } from '../shared/content.js';
import { analyticsQuery, parseRate } from '../shared/analytics.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADMIN_ONLY, CAPABILITIES, assert, AppError, baseRecord, bool, ids, number, object, onlyKeys, parseRule, parseSettings, requireCapability, snowflake, text, uuid, type Authority, type Calibration, type Group, type ModerationEvent, type RecordBase, type ReferenceImage, type RoleGrant, type Rule, type RuleInput, type Evaluation } from '../shared/domain.js';
import { Services } from './services.js';
import { digest, token, safeError, csvCell } from './security.js';
import { normalize, downloadAttachment, supportedAttachment, NORMALIZATION_HASH_VERSION } from './images.js';
import type { Config } from './config.js';
import { fingerprint } from './policy.js';
import { assetVersion, type Release } from './release.js';
interface Reply {
    status?: number;
    body?: unknown;
    bytes?: Buffer;
    type?: string;
    headers?: Record<string, string>;
}
const MAX_BODY = 12 * 1024 * 1024;
const evolved = <T extends RecordBase>(old: T, changes: Partial<T>): T => ({ ...old, ...changes, revision: old.revision + 1, updatedAt: new Date().toISOString() });
function requireAdmin(a: Authority) { assert(a.owner || a.administrator, 'administrator_required', 403); }
function nullableUUID(v: unknown): string | null { assert(v === null || uuid(v), 'invalid_uuid'); return v; }
function decodeImage(v: unknown): Buffer { assert(typeof v === 'string' && v.length <= 11184812 && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0, 'invalid_image_base64'); return Buffer.from(v, 'base64'); }
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    assert((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'json_content_type_required', 415);
    const declared = Number(req.headers['content-length'] ?? 0);
    assert(declared <= MAX_BODY, 'request_too_large', 413);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
        size += part.length;
        assert(size <= MAX_BODY, 'request_too_large', 413);
        parts.push(part);
    }
    try {
        return object(JSON.parse(Buffer.concat(parts).toString('utf8')));
    }
    catch (e) {
        if (e instanceof AppError)
            throw e;
        throw new AppError('invalid_json');
    }
}
function rulePermissions(a: Authority, next: RuleInput, old?: Rule) {
    if (!old && next.action !== 'none' || old && (old.action !== next.action || old.deleteMessage !== next.deleteMessage || old.automatic !== next.automatic))
        requireCapability(a, 'actions.change');
    if (next.action === 'timeout' && (!old || old.timeoutSeconds !== next.timeoutSeconds || old.action !== next.action))
        requireCapability(a, 'timeouts.configure');
    if (next.action === 'kick' && next.enabled)
        requireCapability(a, 'kick.enable');
    if (next.action === 'ban' && next.enabled)
        requireCapability(a, 'ban.enable');
}
export interface Deployment { release: Release | null; storage: string | null }
export function createHttp(services: Services, config: Config, root = process.cwd(), readiness?: () => Promise<boolean>, controllerState?: () => string, deployment?: Deployment) {
    const { store, discord } = services;
    const limits = new Map<string, {
        at: number;
        count: number;
    }>();
    const origins = new Set([config.publicOrigin, `https://${config.clientId}.discordsays.com`]);
    function rate(key: string, max: number) { const now = Date.now(); let r = limits.get(key); if (!r || r.at < now - 60000) {
        r = { at: now, count: 0 };
        limits.set(key, r);
    } r.count++; assert(r.count <= max, 'request_rate_limit', 429); if (limits.size > 10000)
        for (const [k, v] of limits)
            if (v.at < now - 60000)
                limits.delete(k); }
    async function dispatch(req: IncomingMessage, url: URL, origin: string): Promise<Reply> {
        const method = req.method ?? 'GET';
        const p = url.pathname.split('/').filter(Boolean);
        if (url.pathname === '/api/config' && method === 'GET')
            return { body: { clientId: config.clientId, version: '0.1.0', experimental: true } };
        if (url.pathname === '/api/health' && method === 'GET')
            return { body: { status: controllerState?.() ?? 'running', ...(deployment ? { release: deployment.release?.commit ?? null, storage: deployment.storage } : {}) } };
        if (url.pathname === '/api/ready' && method === 'GET') {
            const ready = readiness ? await readiness().catch(() => false) : false;
            return { status: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', ...(controllerState ? { controller: controllerState() } : {}) } };
        }
        if (url.pathname === '/api/auth/start' && method === 'POST') {
            rate('auth:' + req.socket.remoteAddress, 20);
            const nonce = token();
            await store.createNonce(digest(nonce), origin);
            return { body: { nonce } };
        }
        if (['/api/auth/exchange', '/api/auth/renew'].includes(url.pathname) && method === 'POST') {
            rate('auth:' + req.socket.remoteAddress, 20);
            const b = await jsonBody(req);
            const renewing = url.pathname === '/api/auth/renew';
            onlyKeys(b, renewing ? ['accessToken', 'nonce', 'guildId'] : ['code', 'nonce', 'guildId']);
            assert(snowflake(b.guildId), 'invalid_guild');
            assert(typeof b.nonce === 'string' && await store.consumeNonce(digest(b.nonce), origin), 'invalid_or_expired_nonce', 401);
            const auth = renewing ? { userId: await discord.oauthIdentity(text(b.accessToken, 2048)), accessToken: undefined } : await discord.exchange(text(b.code, 2048));
            await store.getSettings(b.guildId);
            const a = await services.authority(b.guildId, auth.userId);
            assert(a.capabilities.length > 0, 'no_delegated_access', 403);
            await seedStarterReferences(services, b.guildId, root);
            const sessionToken = token();
            await store.createSession(digest(sessionToken), { userId: auth.userId, guildId: b.guildId, expiresAt: Date.now() + 15 * 60000 });
            await services.audit(b.guildId, auth.userId, 'session.created', 'session');
            return { body: { sessionToken, accessToken: auth.accessToken, authority: a, expiresIn: 900 } };
        }
        const raw = req.headers.authorization;
        assert(typeof raw === 'string' && raw.startsWith('Bearer ') && raw.length < 200, 'authentication_required', 401);
        const hash = digest(raw.slice(7));
        const session = await store.session(hash);
        assert(session, 'session_expired', 401);
        rate('session:' + hash, 180);
        if (url.pathname === '/api/auth/logout' && method === 'POST') {
            await store.deleteSession(hash);
            return { body: { ok: true } };
        }
        assert(p[0] === 'api' && p[1] === 'g' && snowflake(p[2]), 'route_not_found', 404);
        const guild = p[2];
        assert(guild === session.guildId, 'cross_guild_access_denied', 403);
        // Every guild request verifies LIVE membership/roles. Client claims are never authority.
        const a = await services.authority(guild, session.userId);
        const route = p.slice(3).join('/');
        if (route === 'me' && method === 'GET')
            return { body: a };
        if (route === 'meta' && method === 'GET') {
            assert(a.capabilities.length > 0, 'forbidden', 403);
            return { body: await discord.metadata(guild) };
        }
        if (route === 'analytics/pricing' && method === 'GET') {
            requireCapability(a, 'dashboard.view'); return { body: await store.analytics.rates(guild) };
        }
        if (route === 'analytics/pricing' && method === 'PUT') {
            requireAdmin(a); const rate = parseRate(await jsonBody(req));
            await store.withGuild(guild, async tx => {
                await tx.analytics.putRate(guild, rate);
                await services.audit(guild, a.userId, 'pricing.updated', rate.model, { ...rate, revision: rate.revision + 1 }, tx);
            });
            return { body: await store.analytics.rates(guild) };
        }
        if (['analytics/summary','analytics/daily','analytics/breakdown','analytics/attempts','analytics/export'].includes(route) && method === 'GET') {
            requireCapability(a, 'dashboard.view');
            const query = analyticsQuery(url.searchParams);
            if (route === 'analytics/attempts' || route === 'analytics/export') {
                const page = await store.analytics.attempts(guild, query);
                if (route === 'analytics/attempts') return { body: page };
                const fields = ['id','correlationId','model','purpose','mode','verification','retry','startedAt','completedAt','outcome','error','inputTokens','currency','estimatedCostMicros','pricingRevision','analysisKind','ruleIds'];
                const lines = page.items.map(v => [v.id,v.correlationId,v.model,v.purpose,v.mode,v.verification,v.retry,v.startedAt,v.completedAt,v.outcome,v.error,v.inputTokens ?? 'Usage unknown',v.rate?.currency ?? 'Rate not configured',v.costMicros ?? 'Partial estimate: unavailable',v.rate?.revision ?? '',v.analysisKind ?? 'reference',v.ruleIds?.join(';') ?? '']);
                return { bytes: Buffer.from([fields,...lines].map(row=>row.map(csvCell).join(',')).join('\r\n')), type:'text/csv; charset=utf-8', headers:{'Content-Disposition':'attachment; filename="estimated-jev-usage-page.csv"', ...(page.next ? {'X-Next-Before':page.next.before,'X-Next-Before-Id':page.next.beforeId} : {})} };
            }
            if (route === 'analytics/summary') query.group = 'summary';
            if (route === 'analytics/daily') query.group = 'day';
            return { body: await store.analytics.report(guild, query) };
        }
        if (route === 'dashboard' && method === 'GET') {
            requireCapability(a, 'dashboard.view');
            const [settings, images, rules, events, evaluations, usage, credential] = await Promise.all([store.getSettings(guild), store.all<ReferenceImage>('images', guild), store.all<Rule>('rules', guild), store.all<ModerationEvent>('events', guild), store.all<Evaluation>('evaluations', guild), store.usage(guild), services.credentialStatus(guild)]);
            return { body: { settings, botOnline: discord.online, credential, usage, counts: { images: images.filter(i => i.enabled).length, rules: rules.filter(r => r.enabled).length, evaluations: evaluations.length, events: events.length, successful: events.filter(e => e.actual.includes(':success')).length, suppressedOrFailed: events.filter(e => !e.actual.includes(':success')).length }, recent: events.slice(0, 10) } };
        }
        if (route === 'match-thresholds' && method === 'GET') {
            assert(['rules.create', 'rules.edit', 'rules.view'].some(c => a.capabilities.includes(c as typeof a.capabilities[number])), 'forbidden', 403);
            return { body: (await store.getSettings(guild)).value.thresholds };
        }
        if (p[3] === 'scans') {
            requireAdmin(a);
            const history=new Historical(services);
            if(method==='GET') return {body:await history.list(guild)};
            const b=await jsonBody(req);
            if(method==='POST' && p[4]==='preview') return {body:await history.prepare(guild,session.userId,b)};
            if(method==='POST' && !p[4]) return {body:await history.start(guild,session.userId,b)};
            if(method==='POST' && p[4] && p[5]) return {body:await history.control(guild,session.userId,p[4],p[5])};
            throw new AppError('route_not_found',404);
        }
        if (route === 'settings' && method === 'GET') {
            assert(a.capabilities.includes('dashboard.view') || a.capabilities.includes('channels.configure') || a.owner || a.administrator, 'forbidden', 403);
            return { body: await store.getSettings(guild) };
        }
        if (route === 'settings' && method === 'PUT') {
            requireAdmin(a);
            const b = await jsonBody(req);
            onlyKeys(b, ['value', 'revision', 'acknowledgement']);
            const revision = number(b.revision, 1, 1e9, true);
            await store.withGuild(guild, async (tx) => {
                const old = await tx.getSettings(guild);
                assert(old.revision === revision, 'revision_conflict', 409);
                const value = parseSettings(b.value, old.value);
                assert(value.textStartersInstalled===old.value.textStartersInstalled,'starter_marker_read_only');
                if (value.enforcement && !old.value.enforcement) {
                    assert(!config.production || config.enforcementApproved === true, 'deployment_acceptance_required', 403);
                    assert(b.acknowledgement === 'ENABLE_AUTOMATIC_ENFORCEMENT', 'enforcement_acknowledgement_required');
                    assert(value.channels.length > 0, 'choose_monitored_channels');
                }
                const metadata = await discord.metadata(guild);
                const channelIds = new Set(metadata.channels.map(c => c.id));
                const roleIds = new Set(metadata.roles.map(r => r.id));
                assert([...value.channels, ...value.excludedChannels, ...(value.logChannel ? [value.logChannel] : [])].every(id => channelIds.has(id)), 'channel_not_in_guild');
                assert(value.exemptRoles.every(id => roleIds.has(id)), 'role_not_in_guild');
                await tx.putSettings(guild, value, revision);
                await services.audit(guild, a.userId, 'settings.updated', 'settings', { changed: Object.keys(value).filter(k => JSON.stringify(value[k as keyof typeof value]) !== JSON.stringify(old.value[k as keyof typeof value])) }, tx);
            });
            return { body: await store.getSettings(guild) };
        }
        if (route === 'channels' && method === 'PUT') {
            requireCapability(a, 'channels.configure');
            const b = await jsonBody(req);
            onlyKeys(b, ['channels', 'excludedChannels', 'revision']);
            const channels = ids(b.channels), excluded = ids(b.excludedChannels), revision = number(b.revision, 1, 1e9, true);
            const meta = await discord.metadata(guild);
            assert([...channels, ...excluded].every(id => meta.channels.some(c => c.id === id)), 'channel_not_in_guild');
            await store.withGuild(guild, async (tx) => { const s = await tx.getSettings(guild); assert(s.revision === revision, 'revision_conflict', 409); await tx.putSettings(guild, { ...s.value, channels, excludedChannels: excluded }, revision); await services.audit(guild, a.userId, 'channels.updated', 'settings', {}, tx); });
            return { body: await store.getSettings(guild) };
        }
        if (route === 'pause' && method === 'POST') {
            requireCapability(a, 'enforcement.pause');
            await store.withGuild(guild, async (tx) => { const s = await tx.getSettings(guild); await tx.putSettings(guild, { ...s.value, enforcement: false }, s.revision); await services.audit(guild, a.userId, 'enforcement.paused', 'settings', {}, tx); });
            return { body: { paused: true } };
        }
        if (route === 'credentials' && method === 'GET') {
            requireAdmin(a);
            return { body: await services.credentialStatus(guild) };
        }
        if (route === 'credentials' && method === 'PUT') {
            requireAdmin(a);
            const b = await jsonBody(req);
            onlyKeys(b, ['apiKey']);
            return { body: await services.setCredential(guild, a.userId, text(b.apiKey, 4096)) };
        }
        if (route === 'credentials' && method === 'DELETE') {
            requireAdmin(a);
            const b = await jsonBody(req);
            onlyKeys(b, ['revision']);
            const revision = number(b.revision, 1, 1e9, true);
            await store.withGuild(guild, async (tx) => { const c = await services.credential(guild, tx); assert(c, 'credential_not_found', 404); await tx.remove('credentials', guild, c.id, revision); await services.audit(guild, a.userId, 'credential.removed', c.id, {}, tx); });
            return { body: { configured: false } };
        }
        if (route === 'credentials/test' && method === 'POST') {
            requireAdmin(a);
            return { body: await services.testCredential(guild) };
        }
        if (route === 'groups' && method === 'GET') {
            requireCapability(a, 'images.view');
            return { body: await store.all<Group>('groups', guild) };
        }
        if (route === 'groups' && method === 'POST') {
            requireCapability(a, 'images.edit');
            const b = await jsonBody(req);
            onlyKeys(b, ['name']);
            const r: Group = { ...baseRecord(guild, randomUUID()), name: text(b.name) };
            await store.withGuild(guild, async (tx) => { assert((await tx.all('groups', guild)).length < 100, 'group_limit'); await tx.put('groups', r, 0); await services.audit(guild, a.userId, 'group.created', r.id, {}, tx); });
            return { status: 201, body: r };
        }
        if (p[3] === 'groups' && uuid(p[4]) && p.length === 5) {
            requireCapability(a, 'images.edit');
            const id = p[4];
            if (method === 'PUT' || method === 'DELETE') {
                const b = await jsonBody(req);
                onlyKeys(b, method === 'PUT' ? ['name', 'revision'] : ['revision']);
                const revision = number(b.revision, 1, 1e9, true);
                return store.withGuild(guild, async (tx) => {
                    const old = await tx.get<Group>('groups', guild, id);
                    assert(old, 'group_not_found', 404);
                    assert(old.revision === revision, 'revision_conflict', 409);
                    if (method === 'DELETE') {
                        assert(!(await tx.all<ReferenceImage>('images', guild)).some(i => i.groupId === id) && !(await tx.all<Rule>('rules', guild)).some(r => r.groupId === id), 'group_in_use', 409);
                        await tx.remove('groups', guild, id, revision);
                        await services.audit(guild, a.userId, 'group.removed', id, {}, tx);
                        return { body: { ok: true } };
                    }
                    const next = evolved(old, { name: text(b.name) });
                    await tx.put('groups', next, revision);
                    await services.audit(guild, a.userId, 'group.updated', id, {}, tx);
                    return { body: next };
                });
            }
        }
        if (route === 'images' && method === 'GET') {
            requireCapability(a, 'images.view');
            return { body: await store.all<ReferenceImage>('images', guild) };
        }
        if (p[3] === 'images' && uuid(p[4]) && p[5] === 'content' && p.length === 6 && method === 'GET') {
            requireCapability(a, 'images.view');
            const image = await store.get<ReferenceImage>('images', guild, p[4]);
            assert(image, 'image_not_found', 404);
            return { bytes: await services.objects.get(guild, image.objectKey), type: 'image/jpeg' };
        }
        if (route === 'images' && method === 'POST' || p[3] === 'images' && uuid(p[4]) && p.length === 5 && method === 'PUT') {
            const creating = method === 'POST';
            requireCapability(a, creating ? 'images.add' : 'images.edit');
            const b = await jsonBody(req);
            onlyKeys(b, creating ? ['name', 'groupId', 'enabled', 'base64'] : ['name', 'groupId', 'enabled', 'base64', 'revision']);
            const name = text(b.name), groupId = nullableUUID(b.groupId), enabled = bool(b.enabled);
            const id = creating ? randomUUID() : p[4]!;
            const normalized = b.base64 !== undefined ? await normalize(decodeImage(b.base64)) : null;
            assert(!creating || normalized, 'image_required');
            const objectKey = normalized ? await services.objects.put(guild, normalized) : null;
            return store.withGuild(guild, async (tx) => {
                if (groupId)
                    assert(await tx.get('groups', guild, groupId), 'group_not_found', 404);
                const old = creating ? null : await tx.get<ReferenceImage>('images', guild, id);
                assert(creating || old, 'image_not_found', 404);
                if (creating)
                    assert((await tx.all('images', guild)).length < 250, 'reference_image_limit');
                else
                    assert(old!.revision === number(b.revision, 1, 1e9, true), 'revision_conflict', 409);
                const record: ReferenceImage = { ...(old ?? baseRecord(guild, id)), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), name, groupId, enabled, createdBy: old?.createdBy ?? a.userId,
                    objectKey: objectKey ?? old!.objectKey, sha256: normalized?.sha256 ?? old!.sha256, hashVersion: normalized ? normalized.hashVersion : old?.hashVersion, bytes: normalized?.bytes.length ?? old!.bytes, width: normalized?.width ?? old!.width, height: normalized?.height ?? old!.height };
                await tx.put('images', record, old?.revision ?? 0);
                await services.audit(guild, a.userId, creating ? 'image.created' : 'image.updated', id, { sha256: record.sha256 }, tx);
                return { status: creating ? 201 : 200, body: record };
            });
        }
        if (p[3] === 'images' && uuid(p[4]) && p.length === 5 && method === 'DELETE') {
            requireCapability(a, 'images.delete');
            const b = await jsonBody(req);
            onlyKeys(b, ['revision']);
            const id = p[4], revision = number(b.revision, 1, 1e9, true);
            await store.withGuild(guild, async (tx) => { assert(!(await tx.all<Rule>('rules', guild)).some(r => r.referenceId === id), 'image_used_by_rule', 409); await tx.remove('images', guild, id, revision); await services.audit(guild, a.userId, 'image.removed', id, {}, tx); });
            return { body: { ok: true } };
        }
        if(route === 'text-starters' && method === 'GET') { requireCapability(a,'rules.view'); return {body:TEXT_STARTERS}; }
        if(route === 'text-starters/install' && method === 'POST') { requireAdmin(a); onlyKeys(await jsonBody(req),[]); return {body:await installTextStarters(services,guild,a.userId)}; }
        if (route === 'content-presets' && method === 'GET') { requireCapability(a, 'rules.view'); return { body: CONTENT_PRESETS }; }
        if (route === 'rules' && method === 'GET') {
            requireCapability(a, 'rules.view');
            const rules = await store.all<Rule>('rules', guild), images = await store.all<ReferenceImage>('images', guild), settings = (await store.getSettings(guild)).value;
            return { body: rules.map(r => ({ ...r, approvalCurrent: r.approval?.fingerprint === fingerprint(r, images, settings) })) };
        }
        if (route === 'rules' && method === 'POST' || p[3] === 'rules' && uuid(p[4]) && p.length === 5 && method === 'PUT') {
            const creating = method === 'POST';
            requireCapability(a, creating ? 'rules.create' : 'rules.edit');
            const b = await jsonBody(req);
            onlyKeys(b, ['rule', ...(creating ? [] : ['revision'])]);
            const id = creating ? randomUUID() : p[4]!;
            return store.withGuild(guild, async (tx) => {
                const old = creating ? null : await tx.get<Rule>('rules', guild, id);
                assert(creating || old, 'rule_not_found', 404);
                const next = parseRule(b.rule, old?.threshold);
                if (['content','text'].includes(next.type) && (creating || old?.type !== next.type)) next.automatic = false;
                if(next.type === 'text') { requireAdmin(a); if(next.enabled) assert((await tx.all<Rule>('rules',guild)).filter(r=>r.id!==id&&r.type==='text'&&r.enabled).length<TEXT_LIMITS.rules,'text_active_rule_limit'); }
                if (old)
                    assert(old.revision === number(b.revision, 1, 1e9, true), 'revision_conflict', 409);
                if (creating)
                    assert((await tx.all('rules', guild)).length < 250, 'rule_limit');
                rulePermissions(a, next, old ?? undefined);
                if (next.type === 'content' && next.enabled) {
                    const active = (await tx.all<Rule>('rules', guild)).filter(r => r.id !== id && r.type === 'content' && r.enabled);
                    assert(active.length + 1 <= CONTENT_LIMITS.rules, 'content_active_rule_limit');
                    assert([...active, next].reduce((n, r) => n + 5 + parseContent(r.content).supporting.length, 0) <= CONTENT_LIMITS.questions, 'content_question_limit');
                }
                if (next.referenceId)
                    assert(await tx.get('images', guild, next.referenceId), 'image_not_found', 404);
                if (next.groupId)
                    assert(await tx.get('groups', guild, next.groupId), 'group_not_found', 404);
                const record: Rule = { ...(old ?? baseRecord(guild, id)), ...next, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), approval: null };
                if (next.type !== 'content') delete record.content;
                if (next.type !== 'text') delete record.text;
                await tx.put('rules', record, old?.revision ?? 0);
                await services.audit(guild, a.userId, creating ? 'rule.created' : 'rule.updated', id, { approvalInvalidated: true }, tx);
                return { status: creating ? 201 : 200, body: record };
            });
        }
        if (p[3] === 'rules' && uuid(p[4])) {
            const id = p[4];
            if (p.length === 5 && method === 'DELETE') {
                requireCapability(a, 'rules.delete');
                const b = await jsonBody(req);
                onlyKeys(b, ['revision']);
                await store.withGuild(guild, async (tx) => { await tx.remove('rules', guild, id, number(b.revision, 1, 1e9, true)); await services.audit(guild, a.userId, 'rule.removed', id, {}, tx); });
                return { body: { ok: true } };
            }
            if (p[5] === 'test' && method === 'POST') {
                requireCapability(a, 'matching.test');
                const b = await jsonBody(req);
                onlyKeys(b, ['base64', 'messageUrl', 'imageIds', 'expected', 'context', 'text']);
                assert([b.base64, b.messageUrl, b.imageIds, b.text].filter(v => v !== undefined).length === 1, 'choose_one_sample_source');
                assert(b.context === undefined || typeof b.context === 'string' && b.context.length <= 2000, 'content_context_over_limit');
                const expected = b.expected === undefined ? undefined : bool(b.expected);
                const testRule=await store.get<Rule>('rules',guild,id);
                assert(testRule,'rule_not_found',404);
                if(testRule.type==='text') { assert(b.context===undefined,'text_has_no_external_context'); assert(b.base64===undefined && b.imageIds===undefined,'text_rule_requires_text_sample'); }
                if(b.text!==undefined) assert(testRule.type==='text','text_sample_requires_text_rule');
                if(b.text!==undefined) { assert(typeof b.text==='string','invalid_text_sample'); return {body:await services.testTextRule(guild,a.userId,id,b.text,expected)}; }
                if (b.messageUrl !== undefined) {
                    assert(typeof b.messageUrl === 'string', 'invalid_message_url');
                    const link = /^https:\/\/(?:discord\.com|canary\.discord\.com|ptb\.discord\.com)\/channels\/(\d{6,22})\/(\d{6,22})\/(\d{6,22})$/.exec(b.messageUrl);
                    assert(link, 'invalid_message_url');
                    assert(link[1] === guild, 'message_wrong_guild', 403);
                    await discord.assertCanReadMessage(guild, a.userId, link[2]!);
                    let message;
                    try { message = await discord.currentMessage(link[2]!, link[3]!); }
                    catch (e) { if (e instanceof AppError && e.code === 'discord_http_404') throw new AppError('message_not_found', 404); throw e; }
                    assert(message.guildId === guild && message.channelId === link[2] && message.messageId === link[3], 'message_wrong_guild', 403);
                    if(testRule.type==='text') return {body:await services.testTextRule(guild,a.userId,id,message.content,expected)};
                    const attachments = message.attachments.filter(supportedAttachment);
                    assert(attachments.length, 'message_has_no_supported_images');
                    const results = [];
                    for (const attachment of attachments) {
                        const image = await downloadAttachment(attachment, message.channelId);
                        results.push(await services.testRule(guild, a.userId, id, image, expected, b.context as string | undefined));
                    }
                    return { body: { results } };
                }
                if (b.imageIds !== undefined) {
                    requireCapability(a, 'images.view');
                    assert(Array.isArray(b.imageIds) && b.imageIds.length > 0 && b.imageIds.length <= 20 && b.imageIds.every(uuid), 'invalid_image_ids');
                    const images = await Promise.all([...new Set(b.imageIds as string[])].map(async imageId => {
                        const image = await store.get<ReferenceImage>('images', guild, imageId);
                        assert(image, 'image_not_found', 404);
                        assert(image.hashVersion === NORMALIZATION_HASH_VERSION, 'library_image_requires_reupload');
                        return { bytes: await services.objects.get(guild, image.objectKey), sha256: image.sha256, hashVersion: image.hashVersion, width: image.width, height: image.height };
                    }));
                    const results = [];
                    for (const image of images) results.push(await services.testRule(guild, a.userId, id, image, expected, b.context as string | undefined));
                    return { body: { results } };
                }
                return { body: await services.testRule(guild, a.userId, id, await normalize(decodeImage(b.base64)), expected, b.context as string | undefined) };
            }
            if (p[5] === 'calibration' && method === 'GET') {
                requireCapability(a, 'matching.test');
                return { body: (await store.all<Calibration>('calibrations', guild)).filter(t => t.ruleId === id) };
            }
            if (p[5] === 'approve' && method === 'POST') {
                requireAdmin(a);
                const b = await jsonBody(req);
                onlyKeys(b, ['note']);
                return { body: await services.approveRule(guild, a.userId, id, text(b.note, 1000)) };
            }
        }
        if (route === 'grants' && method === 'GET') {
            assert(a.owner || a.administrator || a.capabilities.includes('moderators.delegate'), 'forbidden', 403);
            return { body: await store.all<RoleGrant>('grants', guild) };
        }
        if (p[3] === 'grants' && snowflake(p[4]) && p.length === 5 && (method === 'PUT' || method === 'DELETE')) {
            const admin = a.owner || a.administrator;
            if (!admin)
                requireCapability(a, 'moderators.delegate');
            const roleId = p[4];
            const b = await jsonBody(req);
            onlyKeys(b, method === 'PUT' ? ['capabilities', 'revision'] : ['revision']);
            const caps = method === 'DELETE' ? [] : b.capabilities;
            assert(Array.isArray(caps) && caps.length <= CAPABILITIES.length && caps.every(c => CAPABILITIES.includes(c)), 'invalid_capabilities');
            assert(!caps.some(c => ADMIN_ONLY.includes(c)), 'administrator_only_capability');
            const revision = number(b.revision, 0, 1e9, true);
            const meta = await discord.metadata(guild);
            assert(meta.roles.some(r => r.id === roleId), 'role_not_found', 404);
            return store.withGuild(guild, async (tx) => {
                const grants = await tx.all<RoleGrant>('grants', guild);
                const old = grants.find(g => g.roleId === roleId);
                assert((old?.revision ?? 0) === revision, 'revision_conflict', 409);
                if (!admin) {
                    assert(!a.roles.includes(roleId) && roleId !== guild, 'cannot_edit_own_or_everyone_grant', 403);
                    assert(caps.every(c => a.capabilities.includes(c) && c !== 'moderators.delegate') && (old?.capabilities ?? []).every(c => a.capabilities.includes(c) && c !== 'moderators.delegate'), 'delegation_escalation_denied', 403);
                }
                if (method === 'DELETE') {
                    assert(old, 'grant_not_found', 404);
                    await tx.remove('grants', guild, old.id, revision);
                    await services.audit(guild, a.userId, 'grant.removed', roleId, {}, tx);
                    return { body: { ok: true } };
                }
                const record: RoleGrant = { ...(old ?? baseRecord(guild, randomUUID())), roleId, capabilities: [...new Set(caps)], revision: revision + 1, updatedAt: new Date().toISOString() };
                await tx.put('grants', record, revision);
                await services.audit(guild, a.userId, 'grant.updated', roleId, { capabilities: record.capabilities }, tx);
                return { body: record };
            });
        }
        if (['events', 'evaluations', 'audit', 'actions'].includes(route) && method === 'GET') {
            requireCapability(a, 'logs.view');
            const list = route === 'actions' ? await store.actions(guild) : await store.all(route as 'events' | 'evaluations' | 'audit', guild);
            const q = (url.searchParams.get('q') ?? '').slice(0, 160).toLowerCase();
            const before = url.searchParams.get('before');
            const filtered = list.filter(r => (!before || r.createdAt < before) && (!q || JSON.stringify(r).toLowerCase().includes(q))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            const page = filtered.slice(0, 100);
            return { body: { items: page, nextBefore: filtered.length > 100 ? page.at(-1)?.createdAt : null, totalRetained: list.length } };
        }
        if (route === 'events/export' && method === 'GET') {
            requireCapability(a, 'logs.view');
            requireCapability(a, 'logs.export');
            const rows = await store.all<ModerationEvent>('events', guild);
            const fields = ['createdAt', 'channelId', 'userId', 'messageId', 'ruleId', 'intended', 'actual', 'reason', 'reviewStatus'] as const;
            const csv = [fields.map(csvCell).join(','), ...rows.map(r => fields.map(f => csvCell(r[f])).join(','))].join('\r\n');
            await services.audit(guild, a.userId, 'logs.exported', 'events', { rows: rows.length });
            return { bytes: Buffer.from(csv), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="typecheck-events.csv"' } };
        }
        if (p[3] === 'events' && uuid(p[4]) && p[5] === 'review' && method === 'POST') {
            requireCapability(a, 'logs.view');
            requireCapability(a, 'rules.edit');
            const b = await jsonBody(req);
            onlyKeys(b, ['status', 'revision']);
            assert(['confirmed', 'false_positive', 'dismissed'].includes(String(b.status)), 'invalid_review_status');
            return store.withGuild(guild, async (tx) => {
                const old = await tx.get<ModerationEvent>('events', guild, p[4]!);
                assert(old, 'event_not_found', 404);
                assert(old.revision === number(b.revision, 1, 1e9, true), 'revision_conflict', 409);
                const next = evolved(old, { reviewStatus: b.status as ModerationEvent['reviewStatus'] });
                await tx.put('events', next, old.revision);
                if (b.status === 'false_positive' && old.ruleId) {
                    const rule = await tx.get<Rule>('rules', guild, old.ruleId);
                    if (rule)
                        await tx.put('rules', evolved(rule, { enabled: false, approval: null }), rule.revision);
                }
                await services.audit(guild, a.userId, 'review.resolved', old.id, { status: b.status }, tx);
                return { body: next };
            });
        }
        throw new AppError('route_not_found', 404);
    }
    // The hosting edge applies long browser caching to .js/.css whatever the app sends,
    // so the page references release-scoped paths and old modules cannot mix with new ones.
    const version = assetVersion(deployment?.release ?? null);
    async function staticFile(requested: string): Promise<Reply> {
        // Only this build's scope: content cached under another release's path would be wrong for a month.
        const pathname = requested.startsWith(`/r/${version}/`) ? requested.slice(version.length + 3) : requested;
        if (pathname === '/') {
            const html = await readFile(resolve(root, 'activity/index.html'), 'utf8');
            return { bytes: Buffer.from(html.replace(/(href|src)="\/(style\.css|activity\/src\/main\.js)"/g, `$1="/r/${version}/$2"`)), type: 'text/html; charset=utf-8' };
        }
        const legal: Record<string, string> = { '/terms': 'activity/legal/terms.html', '/privacy': 'activity/legal/privacy.html' };
        if (legal[pathname]) {
            const html = await readFile(resolve(root, legal[pathname]), 'utf8');
            return { bytes: Buffer.from(html.replace('href="/legal.css"', `href="/r/${version}/legal.css"`)), type: 'text/html; charset=utf-8' };
        }
        const fixed: Record<string, string> = { '/style.css': 'activity/style.css', '/legal.css': 'activity/legal/legal.css', '/vendor/discord-sdk.js': 'dist/activity/vendor/discord-sdk.js', '/vendor/THIRD_PARTY_NOTICES.txt': 'dist/activity/vendor/THIRD_PARTY_NOTICES.txt', '/shared/analytics.js':'dist/shared/analytics.js','/shared/content.js':'dist/shared/content.js','/shared/text.js':'dist/shared/text.js','/shared/text-starters.js':'dist/shared/text-starters.js','/shared/domain.js': 'dist/shared/domain.js' };
        const fonts: Record<string, string> = { '/fonts/schibsted-grotesk-400.woff2': 'activity/fonts/schibsted-grotesk-400.woff2', '/fonts/schibsted-grotesk-500.woff2': 'activity/fonts/schibsted-grotesk-500.woff2', '/fonts/vt323-400.woff2': 'activity/fonts/vt323-400.woff2', '/fonts/jetbrains-mono-400.woff2': 'activity/fonts/jetbrains-mono-400.woff2' };
        if (fonts[pathname]) {
            let bytes: Buffer;
            try {
                bytes = await readFile(resolve(root, fonts[pathname]));
            }
            catch {
                throw new AppError('not_found', 404);
            }
            return { bytes, type: 'font/woff2', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } };
        }
        let file = fixed[pathname];
        if (/^\/activity\/src\/[a-z-]+\.js$/.test(pathname))
            file = 'dist' + pathname;
        assert(file, 'not_found', 404);
        let bytes: Buffer;
        try {
            bytes = await readFile(resolve(root, file));
        }
        catch {
            throw new AppError('asset_not_built_run_npm_build', 404);
        }
        return { bytes, type: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8' };
    }
    const server = createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader('X-Request-Id', requestId);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com");
        if (config.production)
            res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        try {
            const url = new URL(req.url ?? '/', config.publicOrigin);
            const origin = req.headers.origin ?? '';
            if (origin) {
                assert(origins.has(origin), 'origin_denied', 403);
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
            }
            if (req.method === 'OPTIONS') {
                assert(origin, 'origin_required', 403);
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                res.writeHead(204).end();
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method ?? 'GET'))
                assert(origin && origins.has(origin), 'origin_required', 403);
            if (!url.pathname.startsWith('/api/'))
                assert(req.method === 'GET' || req.method === 'HEAD', 'method_not_allowed', 405);
            const reply = url.pathname.startsWith('/api/') ? await dispatch(req, url, origin) : await staticFile(url.pathname);
            res.statusCode = reply.status ?? 200;
            for (const [k, v] of Object.entries(reply.headers ?? {}))
                res.setHeader(k, v);
            res.setHeader('Content-Type', reply.type ?? 'application/json; charset=utf-8');
            res.end(req.method === 'HEAD' ? undefined : reply.bytes ?? JSON.stringify(reply.body ?? {}));
        }
        catch (e) {
            if(e instanceof Deferred) res.setHeader('Retry-After',String(Math.max(1,Math.ceil((e.until-Date.now())/1000))));
            res.statusCode = e instanceof AppError ? e.status : 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: safeError(e), requestId, ...(e instanceof Deferred?{nextAttempt:e.until}:{}) }));
        }
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 150000;
    server.keepAliveTimeout = 5000;
    return server;
}
