import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../server/gateway.js';
import type { DiscordRest } from '../server/discord.js';
import type { ImageMessage } from '../shared/domain.js';
class Socket extends EventTarget {
    static OPEN = 1;
    static latest: Socket;
    readyState = 1;
    sent: any[] = [];
    constructor(_url: string) { super(); Socket.latest = this; }
    send(s: string) { this.sent.push(JSON.parse(s)); }
    close(code = 1000) { if (this.readyState === 3)
        return; this.readyState = 3; const e = new Event('close'); Object.assign(e, { code }); this.dispatchEvent(e); }
    receive(p: unknown) { const e = new Event('message'); Object.assign(e, { data: JSON.stringify(p) }); this.dispatchEvent(e); }
}
const tick = () => new Promise(r => setTimeout(r, 5));
async function harness(t: any) {
    const original = globalThis.WebSocket;
    (globalThis as any).WebSocket = Socket;
    const rest = { online: false, botId: '100000000000000003' } as DiscordRest;
    const messages: ImageMessage[] = [];
    const errors: string[] = [];
    const gateway = new Gateway(rest, 'test-token', async (m) => { messages.push(m); }, e => errors.push(e));
    const done = (gateway as unknown as {
        connect(url: string): Promise<void>;
    }).connect('wss://gateway.discord.gg');
    const socket = Socket.latest;
    t.after(async () => { gateway.stop(); await done; (globalThis as any).WebSocket = original; });
    socket.receive({ op: 10, d: { heartbeat_interval: 60000 } });
    await tick();
    return { gateway, socket, rest, messages, errors };
}
test('Gateway HELLO requests guild messages and privileged message content', async (t) => { const { socket } = await harness(t); assert.equal(socket.sent[0].op, 2); assert.equal(socket.sent[0].d.intents, 1 | 512 | 32768); });
test('Gateway READY reports online and server heartbeat carries last sequence', async (t) => { const { socket, rest } = await harness(t); socket.receive({ op: 0, s: 17, t: 'READY', d: { session_id: 'test', resume_gateway_url: 'wss://gateway.discord.gg' } }); socket.receive({ op: 1 }); await tick(); assert.equal(rest.online, true); assert.deepEqual(socket.sent.at(-1), { op: 1, d: 17 }); });
test('Gateway rejects incomplete messages without inventing safe text', async (t) => { const { socket, messages } = await harness(t); socket.receive({ op: 0, s: 18, t: 'MESSAGE_CREATE', d: { guild_id: '100000000000000001', attachments: [], content: 'not inspected' } }); await tick(); assert.equal(messages.length, 0); });
test('Gateway passes transient content and image metadata to privacy-preserving ingestion', async (t) => { const { socket, messages } = await harness(t); socket.receive({ op: 0, s: 19, t: 'MESSAGE_CREATE', d: { guild_id: '100000000000000001', channel_id: '100000000000000002', id: '100000000000000004', author: { id: '100000000000000005', bot: false }, content: 'not retained', attachments: [{ id: '100000000000000006', url: 'https://cdn.discordapp.com/attachments/100000000000000002/100000000000000006/test.png', size: 100, content_type: 'image/png', filename: 'test.png' }] } }); await tick(); assert.equal(messages.length, 1); assert.equal(messages[0]!.content, 'not retained'); assert.equal(messages[0]!.attachments.length, 1); });

test('Gateway forwards complete text-only creates and edits; deletes do not enqueue evidence',async t=>{const {socket,messages}=await harness(t);const d={guild_id:'100000000000000001',channel_id:'100000000000000002',id:'100000000000000004',author:{id:'100000000000000005'},content:'native text',attachments:[]};socket.receive({op:0,t:'MESSAGE_CREATE',d});socket.receive({op:0,t:'MESSAGE_UPDATE',d:{...d,content:'edited text'}});socket.receive({op:0,t:'MESSAGE_DELETE',d});await tick();assert.deepEqual(messages.map(m=>m.content),['native text','edited text']);});
