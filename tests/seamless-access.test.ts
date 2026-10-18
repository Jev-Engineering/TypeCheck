import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageServer, effectiveAuthority, type MemberInfo } from '../shared/domain.js';
import { DiscordRest } from '../server/discord.js';
import { Onboarding } from '../server/onboarding.js';
import { registerTools, type BrowserTool } from '../activity/src/onboarding.js';
import { fixture, G, MOD, ROLE, CHANNEL } from './helpers.js';

test('Manage Server grants application management without claiming Discord Administrator', () => {
    const member: MemberInfo = { guildId: G, userId: MOD, roles: [ROLE], owner: false, administrator: false, manageGuild: true };
    const authority = effectiveAuthority(member, []);
    assert.equal(authority.administrator, false);
    assert.equal(authority.owner, false);
    assert.equal(canManageServer(authority), true);
    assert.ok(authority.capabilities.includes('credentials.manage'));
    assert.ok(authority.capabilities.includes('permissions.manage'));
    for (const manageGuild of [undefined, false, 'true', 1]) {
        const unverified = { ...member, manageGuild } as MemberInfo;
        assert.equal(canManageServer(unverified), false);
        assert.deepEqual(effectiveAuthority(unverified, []).capabilities, []);
    }
});

test('Discord authority derives Manage Server from live permission bits rather than role names', async () => {
    let permissions = '32';
    const rest = new DiscordRest('test-bot', G, 'test-secret', (async (url: string | URL | Request) => {
        return String(url).endsWith('/members/' + MOD)
            ? Response.json({ user: { id: MOD }, roles: [ROLE] })
            : Response.json({ id: G, owner_id: '100000000000099999', roles: [
                { id: G, name: '@everyone', permissions: '0', position: 0 },
                { id: ROLE, name: 'Administrator', permissions, position: 1 }
            ] });
    }) as typeof fetch);
    const manager = await rest.memberInfo(G, MOD);
    assert.equal(manager.manageGuild, true);
    assert.equal(manager.administrator, false);
    for (permissions of ['0', '16', '8192']) {
        const member = await rest.memberInfo(G, MOD);
        assert.equal(member.manageGuild, false);
        assert.equal(canManageServer(member), false);
    }
});

test('server manager completes onboarding without role grants and loses access after revocation', async t => {
    const f = await fixture(t);
    f.discord.members.get(MOD)!.manageGuild = true;
    const setup = new Onboarding(f.services);
    assert.equal((await setup.context(G, MOD)).manageGuild, true);
    const plan = await setup.plan(G, MOD, 'manager-session', {
        presets: ['scam_phishing'], channels: [CHANNEL], excludedChannels: [], exemptRoles: [], logChannel: CHANNEL, customizations: {}
    });
    const ref = { planId: plan.id, digest: plan.digest };
    await setup.transition(G, MOD, 'manager-session', ref, 'accept');
    f.discord.members.get(MOD)!.manageGuild = false;
    await assert.rejects(setup.transition(G, MOD, 'manager-session', ref, 'apply'), /server_management_required/);
    assert.equal((await f.store.all('rules', G)).length, 0);
    f.discord.members.get(MOD)!.manageGuild = true;
    await setup.transition(G, MOD, 'manager-session', ref, 'apply');
    assert.equal((await f.store.all('rules', G)).length, 3);
    assert.equal((await f.store.all('grants', G)).length, 0);
    assert.equal((await f.store.getSettings(G)).value.enforcement, false);
    assert.equal(f.discord.performed.length, 0);
});

test('Activity tools accept live Manage Server authority and reject retained callbacks after revocation', async () => {
    const tools: BrowserTool[] = [];
    let manageGuild = true, calls = 0;
    await registerTools({ registerTool: async tool => { tools.push(tool); } }, async path => {
        if (path === 'me') return { owner: false, administrator: false, manageGuild };
        calls++; return {};
    }, () => {}, new AbortController().signal);
    await tools[0]!.execute({});
    assert.equal(calls, 1);
    manageGuild = false;
    await assert.rejects(tools[0]!.execute({}), /server_management_required/);
    assert.equal(calls, 1);
});
