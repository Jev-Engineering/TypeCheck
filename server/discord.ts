import { Throttle, Deferred, retryAt, scopeHash } from './throttle.js';
import { AppError, assert, snowflake, type Action, type ImageMessage, type MemberInfo, type Settings } from '../shared/domain.js';
import { readBounded } from './images.js';
const API = 'https://discord.com/api/v10';
const P = { ADMIN: 8n, MANAGE_GUILD: 32n, VIEW: 1024n, SEND: 2048n, MANAGE_MESSAGES: 8192n, KICK: 2n, BAN: 4n, MODERATE: 1n << 40n };
export interface DiscordRole {
    id: string;
    name: string;
    position: number;
    permissions: string;
}
export interface DiscordGuild {
    id: string;
    name: string;
    owner_id: string;
    roles: DiscordRole[];
}
export interface DiscordMember {
    user?: {
        id: string;
        bot?: boolean;
    };
    roles: string[];
}
export interface DiscordChannel {
    id: string;
    guild_id?: string;
    name?: string;
    type: number;
    parent_id?: string | null;
    permission_overwrites?: {
        id: string;
        type: number;
        allow: string;
        deny: string;
    }[];
}
export interface DiscordAdapter {
    readonly online: boolean;
    readonly botId: string;
    exchange(code: string, redirectUri?: string): Promise<{
        accessToken: string;
        userId: string;
    }>;
    oauthIdentity(accessToken: string): Promise<string>;
    memberInfo(guild: string, user: string): Promise<MemberInfo>;
    metadata(guild: string): Promise<{
        name: string;
        roles: DiscordRole[];
        channels: DiscordChannel[];
    }>;
    assertCanReadMessage(guild: string, user: string, channel: string): Promise<void>;
    assertCanNotify?(guild: string, channel: string): Promise<void>;
    history?(guild: string, channel: string, before: string): Promise<ImageMessage[]>;
    currentMessage(channel: string, message: string): Promise<ImageMessage>;
    preflight(message: ImageMessage, action: Action, settings: Settings): Promise<void>;
    perform(message: ImageMessage, action: Action, seconds: number, reason: string): Promise<void>;
    notify(guild: string, channel: string, content: string): Promise<void>;
    dm(user: string, content: string): Promise<void>;
}
export function guildPermissions(guild: DiscordGuild, member: DiscordMember): bigint {
    if (member.user?.id === guild.owner_id)
        return ~0n;
    return guild.roles.filter(r => r.id === guild.id || member.roles.includes(r.id)).reduce((v, r) => v | BigInt(r.permissions), 0n);
}
export function channelPermissions(guild: DiscordGuild, member: DiscordMember, channel: DiscordChannel): bigint {
    let p = guildPermissions(guild, member);
    if ((p & P.ADMIN) !== 0n)
        return ~0n;
    const o = channel.permission_overwrites ?? [];
    const everyone = o.find(v => v.id === guild.id && v.type === 0);
    if (everyone)
        p = (p & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
    let allow = 0n, deny = 0n;
    for (const r of o.filter(r => r.type === 0 && member.roles.includes(r.id))) {
        allow |= BigInt(r.allow);
        deny |= BigInt(r.deny);
    }
    p = (p & ~deny) | allow;
    const user = o.find(v => v.type === 1 && v.id === member.user?.id);
    if (user)
        p = (p & ~BigInt(user.deny)) | BigInt(user.allow);
    return p;
}
export class DiscordRest implements DiscordAdapter {
    online = false;
    botId = '';
    throttle?: Throttle;
    private tail: Promise<unknown> = Promise.resolve();
    private waiting = 0;
    constructor(private token: string, private clientId: string, private clientSecret: string, private http: typeof fetch = fetch) { }
    private async json(url: string, init: RequestInit, rate?: {route: string; major: string; global: string}): Promise<any> {
        let response: Response;
        try {
            response = await this.http(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
        }
        catch {
            throw new AppError('discord_network_unknown_outcome', 503);
        }
        if (rate && this.throttle) {
            const bucket = response.headers.get('x-ratelimit-bucket');
            const key = bucket ? rate.global+':'+bucket+':'+rate.major : rate.route;
            if (bucket) await this.throttle.bind(rate.route,key);
            if (response.headers.get('x-ratelimit-remaining') === '0') {
                const seconds = Number(response.headers.get('x-ratelimit-reset-after'));
                const absolute = Number(response.headers.get('x-ratelimit-reset'))*1000;
                await this.throttle.delay(key, Math.max(Date.now()+100, seconds>0 ? Date.now()+seconds*1000 : absolute));
            }
        }
        if (response.status === 204)
            return null;
        const bytes = await readBounded(response, 4 * 1024 * 1024);
        let data: any = null;
        try {
            if (bytes.length)
                data = JSON.parse(bytes.toString('utf8'));
        }
        catch {
            throw new AppError('discord_response_invalid', 502);
        }
        if (response.status === 429) {
            const until=retryAt(response.headers,data?.retry_after);
            if(rate && this.throttle) {
                const global=data?.global===true || response.headers.get('x-ratelimit-global')==='true' || response.headers.get('x-ratelimit-scope')==='global';
                await this.throttle.delay(global ? rate.global : (await this.throttle.bucket(rate.route) ?? rate.route),until);
            }
            throw new Deferred(until,'discord_rate_limit_deferred');
        }
        if(response.status===401&&rate&&this.throttle) await this.throttle.delay(rate.global,8640000000000000);
        if (!response.ok)
            throw new AppError(`discord_http_${response.status}`, response.status === 401 ? 401 : response.status === 403 ? 403 : 502);
        return data;
    }
    async request(path: string, method = 'GET', body?: unknown, reason?: string): Promise<any> {
        assert(path.startsWith('/') && !path.includes('://'), 'invalid_discord_path');
        assert(this.waiting < 64, 'discord_queue_full', 503);
        this.waiting++;
        const task = async () => {
            try {
                const global='discord:'+scopeHash(this.token);
                const parts=path.split('?')[0]!.split('/');
                const major=['channels','guilds','webhooks'].includes(parts[1]??'') ? parts.slice(1,parts[1]==='webhooks'?4:3).join('/') : 'none';
                const route=global+':'+method+':'+parts.map((p,i)=>i>2 && /^\d+$/.test(p)?':id':p).join('/');
                await this.throttle?.check(global);
                await this.throttle?.check(await this.throttle.bucket(route) ?? route);
                const headers: Record<string,string>={Authorization:'Bot '+this.token,'Content-Type':'application/json'};
                if(reason) headers['X-Audit-Log-Reason']=encodeURIComponent(reason.slice(0,300));
                let release: (()=>Promise<void>)|undefined;
                if(this.throttle) {
                    const interval=Number(process.env.DISCORD_MIN_INTERVAL_MS??40);
                    assert(Number.isSafeInteger(interval)&&interval>=20&&interval<=100,'invalid_discord_interval');
                    const enter=()=>this.throttle!.enter(global+':admission',interval,20000);
                    try { release=await enter(); } catch(e) {
                        if(!(e instanceof Deferred)||e.until-Date.now()>100) throw e;
                        await new Promise(r=>setTimeout(r,Math.max(1,e.until-Date.now()+1))); release=await enter();
                    }
                }
                try { return await this.json(API+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)},{global,route,major}); }
                finally { await release?.(); }
            }
            finally {
                this.waiting--;

            }
        };
        const result = this.tail.then(task, task);
        this.tail = result.catch(() => { });
        return result;
    }
    async initialize() { const me = await this.request('/users/@me'); assert(snowflake(me.id), 'discord_identity_invalid'); this.botId = me.id; }
    async exchange(code: string, redirectUri?: string) {
        assert(typeof code === 'string' && code.length >= 1 && code.length <= 2048, 'invalid_oauth_code');
        const result = await this.json('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'authorization_code', code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) }) });
        assert(typeof result?.access_token === 'string', 'oauth_exchange_failed', 401);
        const me = await this.json(API + '/users/@me', { headers: { Authorization: `Bearer ${result.access_token}` } });
        assert(snowflake(me?.id), 'oauth_identity_invalid', 401);
        // Refresh token is intentionally discarded. Short-lived app sessions re-authorize.
        return { accessToken: result.access_token as string, userId: me.id as string };
    }
    async oauthIdentity(accessToken: string): Promise<string> {
        const auth = await this.json(API + '/oauth2/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
        assert(auth?.application?.id === this.clientId && auth?.scopes?.includes('identify') && snowflake(auth?.user?.id) && Date.parse(auth.expires) > Date.now(), 'oauth_identity_invalid', 401);
        return auth.user.id;
    }
    async memberInfo(guild: string, user: string): Promise<MemberInfo> {
        const g: DiscordGuild = await this.request(`/guilds/${guild}`);
        const m: DiscordMember = await this.request(`/guilds/${guild}/members/${user}`);
        assert(g.id === guild && m.user?.id === user, 'discord_membership_mismatch', 403);
        const permissions = guildPermissions(g, m);
        return { userId: user, guildId: guild, owner: g.owner_id === user, administrator: (permissions & P.ADMIN) !== 0n, manageGuild: (permissions & P.MANAGE_GUILD) !== 0n, roles: m.roles };
    }
    async metadata(guild: string) { const g: DiscordGuild = await this.request(`/guilds/${guild}`); const channels: DiscordChannel[] = await this.request(`/guilds/${guild}/channels`); return { name: g.name, roles: g.roles, channels }; }
    async assertCanReadMessage(guild: string, user: string, channelId: string) {
        const [g, member, original]: [DiscordGuild, DiscordMember, DiscordChannel] = await Promise.all([
            this.request(`/guilds/${guild}`), this.request(`/guilds/${guild}/members/${user}`), this.request(`/channels/${channelId}`)
        ]);
        assert(g.id === guild && member.user?.id === user && original.id === channelId && original.guild_id === guild, 'channel_guild_mismatch', 403);
        let channel = original;
        if ([10, 11, 12].includes(original.type)) {
            assert(original.parent_id, 'message_channel_invalid', 403);
            channel = await this.request(`/channels/${original.parent_id}`);
            assert(channel.guild_id === guild, 'channel_guild_mismatch', 403);
        }
        const permissions = channelPermissions(g, member, channel);
        if (original.type === 12 && (permissions & (1n << 34n)) === 0n) {
            // Private threads require membership unless Manage Threads is granted.
            const membership = await this.request(`/channels/${channelId}/thread-members/${user}`);
            assert(membership?.user_id === user, 'message_read_permission_required', 403);
        }
        assert((permissions & 1024n) !== 0n && (permissions & 65536n) !== 0n, 'message_read_permission_required', 403);
    }
    async assertCanNotify(guild: string, channelId: string) {
        const [g,bot,channel]: [DiscordGuild,DiscordMember,DiscordChannel] = await Promise.all([this.request(`/guilds/${guild}`),this.request(`/guilds/${guild}/members/${this.botId}`),this.request(`/channels/${channelId}`)]);
        assert(channel.guild_id === guild,'channel_guild_mismatch',403);
        const permissions=channelPermissions(g,bot,channel);
        assert((permissions & P.VIEW)!==0n && (permissions & P.SEND)!==0n,'bot_missing_send_messages',403);
    }
    async history(guild: string, channel: string, before: string): Promise<ImageMessage[]> {
        const rows=await this.request('/channels/'+channel+'/messages?limit=1&before='+before);
        assert(Array.isArray(rows) && rows.length<=1,'invalid_history_page',502);
        return rows.map(raw=>parseDiscordMessage({...raw,guild_id:guild,channel_id:channel}));
    }
    async currentMessage(channel: string, message: string): Promise<ImageMessage> {
        const [m, c] = await Promise.all([this.request(`/channels/${channel}/messages/${message}`), this.request(`/channels/${channel}`)]);
        return parseDiscordMessage({ ...m, guild_id: c.guild_id }, true);
    }
    async preflight(message: ImageMessage, action: Action, settings: Settings) {
        const { guildId: guild, userId: user, channelId } = message;
        assert(user !== this.botId, 'self_moderation_suppressed', 403);
        const g: DiscordGuild = await this.request(`/guilds/${guild}`);
        const bot: DiscordMember = await this.request(`/guilds/${guild}/members/${this.botId}`);
        let channel: DiscordChannel = await this.request(`/channels/${channelId}`);
        assert(channel.guild_id === guild, 'channel_guild_mismatch', 403);
        if ([10, 11, 12].includes(channel.type) && channel.parent_id)
            channel = await this.request(`/channels/${channel.parent_id}`);
        const cp = channelPermissions(g, bot, channel), gp = guildPermissions(g, bot), admin = (gp & P.ADMIN) !== 0n;
        assert((cp & P.VIEW) !== 0n, 'bot_cannot_view_channel', 403);
        if (action === 'delete') {
            assert((cp & P.MANAGE_MESSAGES) !== 0n, 'bot_missing_manage_messages', 403);
            return;
        }
        assert(!message.webhook, 'webhook_has_no_member_sanction', 403);
        const target: DiscordMember = await this.request(`/guilds/${guild}/members/${user}`);
        assert(g.owner_id !== user && (guildPermissions(g, target) & P.ADMIN) === 0n, 'protected_member', 403);
        assert(!target.roles.some(r => settings.exemptRoles.includes(r)), 'exempt_role', 403);
        if (action === 'warn') {
            assert((cp & P.SEND) !== 0n, 'bot_missing_send_messages', 403);
            return;
        }
        const need = action === 'timeout' ? P.MODERATE : action === 'kick' ? P.KICK : action === 'ban' ? P.BAN : 0n;
        assert(admin || (gp & need) !== 0n, 'bot_missing_moderation_permission', 403);
        const highest = (m: DiscordMember) => Math.max(0, ...g.roles.filter(r => m.roles.includes(r.id)).map(r => r.position));
        assert(highest(bot) > highest(target), 'role_hierarchy_protected', 403);
    }
    async perform(m: ImageMessage, action: Action, seconds: number, reason: string) {
        if (action === 'delete') {
            await this.request(`/channels/${m.channelId}/messages/${m.messageId}`, 'DELETE', undefined, reason);
            return;
        }
        if (action === 'warn') {
            await this.request(`/channels/${m.channelId}/messages`, 'POST', { content: `<@${m.userId}> Moderation warning: ${reason}`, allowed_mentions: { parse: [], users: [m.userId] } });
            return;
        }
        if (action === 'timeout') {
            assert(seconds >= 1 && seconds <= 2419200, 'invalid_timeout');
            await this.request(`/guilds/${m.guildId}/members/${m.userId}`, 'PATCH', { communication_disabled_until: new Date(Date.now() + seconds * 1000).toISOString() }, reason);
            return;
        }
        if (action === 'kick') {
            await this.request(`/guilds/${m.guildId}/members/${m.userId}`, 'DELETE', undefined, reason);
            return;
        }
        if (action === 'ban') {
            await this.request(`/guilds/${m.guildId}/bans/${m.userId}`, 'PUT', { delete_message_seconds: 0 }, reason);
            return;
        }
        throw new AppError('unsupported_execution_action');
    }
    async notify(guild: string, channel: string, content: string) { const c = await this.request(`/channels/${channel}`); assert(c.guild_id === guild, 'log_channel_wrong_guild', 403); await this.request(`/channels/${channel}/messages`, 'POST', { content: content.slice(0, 1900), allowed_mentions: { parse: [] } }); }
    async dm(user: string, content: string) { const c = await this.request('/users/@me/channels', 'POST', { recipient_id: user }); await this.request(`/channels/${c.id}/messages`, 'POST', { content: content.slice(0, 1900), allowed_mentions: { parse: [] } }); }
}
export function parseDiscordMessage(raw: any, includeContext = false): ImageMessage {
    assert(snowflake(raw.guild_id) && snowflake(raw.channel_id) && snowflake(raw.id) && snowflake(raw.author?.id), 'incomplete_discord_message');
    assert(Array.isArray(raw.attachments) && raw.attachments.length <= 100, 'incomplete_discord_attachments');
    return { editedAt: typeof raw.edited_timestamp==='string'?raw.edited_timestamp:null, ...(includeContext && typeof raw.content === 'string' ? { content: raw.content } : {}), guildId: raw.guild_id, channelId: raw.channel_id, messageId: raw.id, userId: raw.author.id, bot: raw.author.bot === true, webhook: !!raw.webhook_id,
        attachments: raw.attachments.filter((a: any) => snowflake(a.id) && typeof a.url === 'string' && Number.isFinite(a.size) && typeof a.filename === 'string')
            .map((a: any) => ({ id: a.id, url: a.url, size: a.size, contentType: typeof a.content_type === 'string' ? a.content_type : null, filename: a.filename })) };
}
