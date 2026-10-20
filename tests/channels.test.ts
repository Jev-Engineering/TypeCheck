import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedChannelGroups, type ChannelMetadata } from '../shared/channels.js';
import { DiscordRest, type DiscordChannel } from '../server/discord.js';
import { Onboarding } from '../server/onboarding.js';
import { fixture, G, ADMIN, CHANNEL } from './helpers.js';

const categoryA = '100000000000000041', categoryB = '100000000000000042';

test('channel choices reproduce Discord category and channel positions instead of API or name order', () => {
    const channels: ChannelMetadata[] = [
        { id: '100000000000000051', name: 'a-last', type: 0, parent_id: categoryA, position: 9 },
        { id: categoryA, name: 'Z • First category', type: 4, position: 0 },
        { id: '100000000000000052', name: 'second-category', type: 0, parent_id: categoryB, position: 0 },
        { id: '100000000000000053', name: 'announcements', type: 5, parent_id: categoryA, position: 1 },
        { id: categoryB, name: 'A • Second category', type: 4, position: 10 },
        { id: CHANNEL, name: 'general', type: 0, parent_id: null, position: 20 },
        { id: '100000000000000054', name: 'voice', type: 2, parent_id: categoryA, position: 0 },
        { id: '100000000000000055', name: 'forum', type: 15, parent_id: categoryB, position: 1 }
    ];
    const original = structuredClone(channels);
    const groups = orderedChannelGroups(channels);
    assert.deepEqual(groups.map(({id,name,channels}) => ({id,name,channels:channels.map(channel => channel.name)})), [
        { id: null, name: 'Uncategorized', channels: ['general'] },
        { id: categoryA, name: 'Z • First category', channels: ['announcements', 'a-last'] },
        { id: categoryB, name: 'A • Second category', channels: ['second-category'] }
    ]);
    assert.deepEqual(channels, original);
    assert.deepEqual(orderedChannelGroups([...channels].reverse()), groups);
});

test('position ties use exact numeric snowflakes for categories and children', () => {
    const early = '999999999999999999', late = '1000000000000000000';
    const first = '1000000000000000051', second = '1000000000000000052';
    const groups = orderedChannelGroups([
        { id: late, name: 'later', type: 4, position: 0 },
        { id: second, type: 0, parent_id: early, position: 3 },
        { id: early, name: 'earlier', type: 4, position: 0 },
        { id: first, type: 5, parent_id: early, position: 3 },
        { id: CHANNEL, type: 0, parent_id: late, position: 0 }
    ]);
    assert.deepEqual(groups.map(group => group.id), [early, late]);
    assert.deepEqual(groups[0]!.channels.map(channel => channel.id), [first, second]);
});

test('missing parents and optional metadata keep eligible channels visible and deterministic', () => {
    const channels: ChannelMetadata[] = [
        { id: 'synthetic-z', name: 'without-position', type: 0, parent_id: 'missing' },
        { id: 'synthetic-a', type: 0 },
        { id: categoryA, type: 4 },
        { id: CHANNEL, type: 5, parent_id: categoryA },
        { id: categoryB, name: 'empty', type: 4, position: 0 },
        { id: 'synthetic-first', type: 0, position: 0 }
    ];
    const groups = orderedChannelGroups(channels);
    assert.deepEqual(groups.map(group => group.name), ['Uncategorized', 'Unnamed category']);
    assert.deepEqual(groups[0]!.channels.map(channel => channel.id), ['synthetic-first', 'synthetic-a', 'synthetic-z']);
    assert.deepEqual(orderedChannelGroups([...channels].reverse()), groups);
    assert.deepEqual(orderedChannelGroups([{id:categoryA,type:4}, {id:CHANNEL,type:2}]), []);
});

test('Discord metadata retains category relationships and positions from the guild response', async () => {
    const channels: DiscordChannel[] = [
        { id: CHANNEL, guild_id: G, name: 'messages', type: 0, parent_id: categoryA, position: 3 },
        { id: categoryA, guild_id: G, name: 'Community', type: 4, parent_id: null, position: 1 }
    ];
    const paths: string[] = [];
    const rest = new DiscordRest('synthetic-token', G, 'synthetic-secret', (async url => {
        paths.push(String(url));
        return Response.json(String(url).endsWith('/channels') ? channels : { id: G, name: 'Test server', roles: [] });
    }) as typeof fetch);
    const meta = await rest.metadata(G);
    assert.deepEqual(meta.channels, channels);
    assert.deepEqual(paths, [`https://discord.com/api/v10/guilds/${G}`, `https://discord.com/api/v10/guilds/${G}/channels`]);
});

test('onboarding inventory retains hierarchy across pages without leaking channel permission data', async t => {
    const f = await fixture(t), onboarding = new Onboarding(f.services);
    const channels: DiscordChannel[] = Array.from({length:51}, (_, index) => ({
        id: String(100000000000001000n + BigInt(index)), name: `channel-${index}`, type: index === 50 ? 5 : 0,
        parent_id: index < 30 ? categoryA : categoryB, position: index,
        permission_overwrites: [{ id: G, type: 0, allow: '1024', deny: '0' }]
    }));
    channels.push({id:categoryB,name:'Second category',type:4,position:1,parent_id:null}, {id:categoryA,name:'First category',type:4,position:0,parent_id:null});
    const meta = await f.services.discord.metadata(G);
    f.services.discord.metadata = async () => ({...meta, channels});
    const first = await onboarding.inventory(G, ADMIN);
    assert.equal(first.channels.nextOffset, 50);
    const second = await onboarding.inventory(G, ADMIN, first.channels.nextOffset!);
    assert.equal(second.channels.nextOffset, null);
    assert.equal(second.channels.total, 53);
    const items = [...first.channels.items, ...second.channels.items];
    assert.deepEqual(items[0], { id: channels[0]!.id, name: 'channel-0', type: 0, parent_id: categoryA, position: 0 });
    assert.ok(!JSON.stringify(items).includes('permission_overwrites'));
    assert.deepEqual(orderedChannelGroups(items).map(group => [group.id, group.channels.length]), [[categoryA,30], [categoryB,21]]);
    await assert.rejects(onboarding.plan(G, ADMIN, 'synthetic-session', {
        presets:['scam_phishing'], channels:[categoryA], excludedChannels:[], exemptRoles:[], logChannel:null, customizations:{}
    }), /channel_not_available/);
});
