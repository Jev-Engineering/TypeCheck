import { AppError } from '../shared/domain.js';
import { DiscordRest, parseDiscordMessage } from './discord.js';
import type { ImageMessage } from '../shared/domain.js';
export class Gateway {
    private sequence: number | null = null;
    private sessionId: string | null = null;
    private resumeURL: string | null = null;
    private stopping = false;
    private socket: WebSocket | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private lastIdentify = 0;
    constructor(private rest: DiscordRest, private token: string, private onMessage: (m: ImageMessage) => Promise<void>, private onError: (code: string) => void) { }
    stop() { this.stopping = true; if (this.timer)
        clearTimeout(this.timer); this.socket?.close(1000); this.rest.online = false; }
    async run() {
        let attempt = 0;
        while (!this.stopping) {
            try {
                const gateway = await this.rest.request('/gateway/bot');
                if (this.stopping) return;
                if (!this.sessionId && gateway.session_start_limit?.remaining === 0) {
                    await this.wait(Math.min(gateway.session_start_limit.reset_after, 3600000));
                    continue;
                }
                const url = new URL(this.resumeURL ?? gateway.url);
                if (url.protocol !== 'wss:' || !url.hostname.endsWith('.discord.gg'))
                    throw new AppError('gateway_url_invalid');
                url.searchParams.set('v', '10');
                url.searchParams.set('encoding', 'json');
                await this.connect(url.toString());
                attempt = this.rest.online ? 0 : attempt + 1;
            }
            catch (e) {
                const code = e instanceof AppError ? e.code : 'gateway_connection_failed';
                this.onError(code);
                if (['gateway_fatal_4004', 'gateway_fatal_4013', 'gateway_fatal_4014'].includes(code))
                    return;
                attempt++;
            }
            this.rest.online = false;
            if (!this.stopping)
                await this.wait(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 1000);
        }
    }
    private wait(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
    private connect(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            this.socket = ws;
            let awaitingAck = false;
            const send = (value: unknown) => { if (!this.stopping && ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify(value)); };
            const beat = (interval: number) => {
                if (awaitingAck) {
                    ws.close(4000, 'heartbeat_ack_missing');
                    return;
                }
                awaitingAck = true;
                send({ op: 1, d: this.sequence });
                this.timer = setTimeout(() => beat(interval), interval);
            };
            ws.addEventListener('message', event => {
                void (async () => {
                    if (this.stopping) return;
                    const text = typeof event.data === 'string' ? event.data : '';
                    if (text.length > 8 * 1024 * 1024)
                        throw new AppError('gateway_payload_limit');
                    const p = JSON.parse(text);
                    if (typeof p.s === 'number')
                        this.sequence = p.s;
                    if (p.op === 10) {
                        const interval = Number(p.d.heartbeat_interval);
                        if (!Number.isFinite(interval) || interval < 1000)
                            throw new AppError('gateway_heartbeat_invalid');
                        this.timer = setTimeout(() => beat(interval), Math.random() * interval);
                        if (this.sessionId)
                            send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } });
                        else {
                            await this.wait(Math.max(0, 5500 - (Date.now() - this.lastIdentify)));
                            this.lastIdentify = Date.now();
                            send({ op: 2, d: { token: this.token, intents: 1 | 512 | 32768, properties: { os: process.platform, browser: 'typecheck', device: 'typecheck' } } });
                        }
                    }
                    else if (p.op === 11)
                        awaitingAck = false;
                    else if (p.op === 1) {
                        awaitingAck = true;
                        send({ op: 1, d: this.sequence });
                    }
                    else if (p.op === 7)
                        ws.close(4000, 'server_reconnect');
                    else if (p.op === 9) {
                        if (!p.d) {
                            this.sessionId = null;
                            this.sequence = null;
                            this.resumeURL = null;
                        }
                        await this.wait(1000 + Math.random() * 4000);
                        ws.close(4000, 'invalid_session');
                    }
                    else if (p.op === 0) {
                        if (p.t === 'READY') {
                            this.sessionId = p.d.session_id;
                            this.resumeURL = p.d.resume_gateway_url;
                            this.rest.online = true;
                        }
                        if (p.t === 'RESUMED')
                            this.rest.online = true;
                        if (['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(p.t) && p.d.guild_id) {
                            // Partial edits with no attachments cannot identify newly added images.
                            if (!Array.isArray(p.d.attachments) || p.d.attachments.length === 0)
                                return;
                            const m = p.d.author ? parseDiscordMessage(p.d) : await this.rest.currentMessage(p.d.channel_id, p.d.id);
                            if (m.userId !== this.rest.botId)
                                await this.onMessage(m);
                        }
                    }
                })().catch(e => this.onError(e instanceof AppError ? e.code : 'gateway_event_error'));
            });
            ws.addEventListener('error', () => { ws.close(); });
            ws.addEventListener('close', e => {
                if (this.timer)
                    clearTimeout(this.timer);
                if ([4007, 4009].includes(e.code)) {
                    this.sessionId = null;
                    this.sequence = null;
                    this.resumeURL = null;
                }
                if ([4004, 4013, 4014].includes(e.code))
                    reject(new AppError(`gateway_fatal_${e.code}`));
                else
                    resolve();
            });
        });
    }
}
