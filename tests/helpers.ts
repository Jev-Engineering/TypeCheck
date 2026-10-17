import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { AppError, baseRecord, type MemberInfo, type ImageMessage, type Action, type Settings, type Rule, type ReferenceImage, type Credential } from '../shared/domain.js';
import { MemoryStore } from './memory.js';
import { Vault } from '../server/security.js';
import { ObjectStore, normalize } from '../server/images.js';
import { JevClient } from '../server/jev.js';
import { Services } from '../server/services.js';
import type { DiscordAdapter } from '../server/discord.js';
import { fingerprint } from '../server/policy.js';
export const G = '100000000000000001', G2 = '100000000000000002', ADMIN = '100000000000000011', MOD = '100000000000000012', USER = '100000000000000013', BOT = '100000000000000014', CHANNEL = '100000000000000021', ROLE = '100000000000000031';
export const API_KEY = 'test-key-not-a-live-provider-credential';
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64');
export function message(n = 1): ImageMessage { const id = String(100000000000000100n + BigInt(n)); return { guildId: G, channelId: CHANNEL, messageId: String(100000000000000200n + BigInt(n)), userId: USER, bot: false, webhook: false, attachments: [{ id, url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${id}/fixture.png`, size: PNG.length, contentType: 'image/png', filename: 'fixture.png' }] }; }
export class FakeDiscord implements DiscordAdapter {
    online = true;
    botId = BOT;
    members = new Map<string, MemberInfo>([
        [ADMIN, { guildId: G, userId: ADMIN, owner: false, administrator: true, roles: [] }],
        [MOD, { guildId: G, userId: MOD, owner: false, administrator: false, roles: [ROLE] }],
        [USER, { guildId: G, userId: USER, owner: false, administrator: false, roles: [] }]
    ]);
    messages = new Map<string, ImageMessage>();
    performed: {
        action: Action;
        message: ImageMessage;
        seconds: number;
    }[] = [];
    notifications: string[] = [];
    failure: string | null = null;
    allow = true;
    async exchange(code: string) { const userId = code === 'admin-code' ? ADMIN : code === 'moderator-code' ? MOD : null; if (!userId)
        throw new AppError('oauth_invalid', 401); return { accessToken: 'fake-oauth-token', userId }; }
    async oauthIdentity(accessToken: string) { if (accessToken !== 'fake-oauth-token') throw new AppError('oauth_identity_invalid', 401); return ADMIN; }
    async memberInfo(guild: string, user: string) { const m = this.members.get(user); if (!m || m.guildId !== guild)
        throw new AppError('not_a_guild_member', 403); return structuredClone(m); }
    async metadata(_guild: string) { return { name: 'Test server', roles: [{ id: G, name: '@everyone', position: 0, permissions: '0' }, { id: ROLE, name: 'Image moderator', position: 1, permissions: '0' }], channels: [{ id: CHANNEL, name: 'images', type: 0, guild_id: G }] }; }
    async currentMessage(_channel: string, id: string) { const m = this.messages.get(id); if (!m)
        throw new AppError('discord_http_404', 502); return structuredClone(m); }
    async preflight(_m: ImageMessage, _a: Action, _s: Settings) { if (!this.allow)
        throw new AppError('bot_missing_permission', 403); }
    async perform(m: ImageMessage, a: Action, seconds: number, _reason: string) { this.performed.push({ action: a, message: m, seconds }); if (this.failure)
        throw new AppError(this.failure, 503); }
    async notify(_g: string, _c: string, content: string) { this.notifications.push(content); }
    async dm(_u: string, content: string) { this.notifications.push(content); }
}
export async function fixture(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new MemoryStore(), discord = new FakeDiscord(), vault = new Vault(randomBytes(32).toString('base64')), objects = new ObjectStore(dir);
    const control = { probability: 0.9999, secondProbability: 0.9999, calls: 0, fail: false };
    const http = (async (_url: unknown, init?: RequestInit) => {
        control.calls++;
        if (control.fail || String((init?.headers as Record<string, string>)?.Authorization).includes('invalid-key'))
            return new Response('{}', { status: 401 });
        const form = init!.body as FormData;
        const request = JSON.parse(await (form.get('request') as Blob).text());
        const second = String(request.questions.match.instructions).includes('Recheck conservatively');
        return Response.json({ model: request.model, answers: { match: { type: 'noul', noul: second ? control.secondProbability : control.probability } }, usage: { input_tokens: 100, output_tokens: 0 } });
    }) as typeof fetch;
    const services = new Services(store, objects, vault, new JevClient(http, async () => { }), discord);
    await store.getSettings(G);
    const image = await normalize(PNG);
    const c: Credential = { ...baseRecord(G, randomUUID()), encrypted: vault.encrypt(G, API_KEY), status: 'valid', validatedAt: new Date().toISOString(), lastError: null };
    await store.put('credentials', c, 0);
    const ref: ReferenceImage = { ...baseRecord(G, randomUUID()), name: 'Reference', groupId: null, enabled: true, objectKey: await objects.put(G, image), sha256: image.sha256, bytes: image.bytes.length, width: 768, height: 768, createdBy: ADMIN };
    await store.put('images', ref, 0);
    return { store, discord, vault, objects, services, control, image, ref };
}
export function rule(ref: ReferenceImage, overrides: Partial<Rule> = {}): Rule { return { ...baseRecord(G, randomUUID()), name: 'Test rule', type: 'individual', referenceId: ref.id, groupId: null, mode: 'exact', threshold: 0.99, action: 'timeout', timeoutSeconds: 600, deleteMessage: false, priority: 0, enabled: true, automatic: true, secondVerification: false, reason: 'Test image rule', approval: null, ...overrides }; }
export async function enable(f: Awaited<ReturnType<typeof fixture>>, r: Rule) { const s = await f.store.getSettings(G); s.value.channels = [CHANNEL]; s.value.enforcement = true; s.value.highImpactEnabled = true; await f.store.putSettings(G, s.value, s.revision); r.approval = { fingerprint: fingerprint(r, [f.ref], s.value), actor: ADMIN, at: new Date().toISOString(), note: 'Unit-test approval fixture; not production evidence' }; await f.store.put('rules', r, 0); return s.value; }
