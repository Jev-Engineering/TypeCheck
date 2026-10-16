import { mkdir, readFile, writeFile, unlink, readdir, stat, rename } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assert, AppError, snowflake, type Attachment } from '../shared/domain.js';
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PIXELS = 24000000;
export interface NormalizedImage {
    bytes: Buffer;
    sha256: string;
    width: number;
    height: number;
}
// Structural boundary avoids coupling application code to decoder-specific type definitions.
// `sharp` is installed through package.json; tests use the same native decoder.
type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => any;
let decoder: SharpFactory | undefined;
async function sharp(): Promise<SharpFactory> { if (!decoder) {
    const name = 'sharp';
    decoder = (await import(name)).default as SharpFactory;
} return decoder; }
// At most two native decodes, with a bounded waiting room for Activity uploads.
let activeDecodes = 0;
const decodeWaiters: Array<() => void> = [];
async function acquireDecoder() { if (activeDecodes < 2) {
    activeDecodes++;
    return;
} assert(decodeWaiters.length < 16, 'image_decoder_busy', 503); await new Promise<void>(resolve => decodeWaiters.push(resolve)); }
function releaseDecoder() { const next = decodeWaiters.shift(); if (next)
    next();
else
    activeDecodes--; }
export async function normalize(input: Buffer): Promise<NormalizedImage> {
    await acquireDecoder();
    try {
        return await normalizeInternal(input);
    }
    finally {
        releaseDecoder();
    }
}
async function normalizeInternal(input: Buffer): Promise<NormalizedImage> {
    assert(input.length > 0 && input.length <= MAX_IMAGE_BYTES, 'image_byte_limit');
    try {
        const factory = await sharp();
        const m = await factory(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: true }).metadata();
        assert(['jpeg', 'png', 'webp', 'gif'].includes(m.format), 'unsupported_image_format');
        assert((m.pages ?? 1) === 1, 'animated_images_not_supported');
        assert(m.width > 0 && m.height > 0 && m.width * m.height <= MAX_PIXELS, 'image_pixel_limit');
        // Fixed 768-square canvas is within every documented Jev dimension bound.
        // Orientation applied before resize; metadata stripped; no text/EXIF sent to the model.
        const bytes: Buffer = await factory(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().resize(768, 768, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg({ quality: 90, progressive: false }).toBuffer();
        return { bytes, width: 768, height: 768, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    catch (e) {
        if (e instanceof AppError)
            throw e;
        throw new AppError('invalid_image');
    }
}
export function supportedAttachment(a: Attachment): boolean {
    return /^image\/(png|jpe?g|webp|gif)$/i.test(a.contentType ?? '') || /\.(png|jpe?g|webp|gif)$/i.test(a.filename);
}
export function attachmentURL(a: Attachment, channelId: string): URL {
    const u = new URL(a.url);
    assert(u.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443'), 'untrusted_attachment_url');
    assert(snowflake(channelId) && snowflake(a.id), 'invalid_attachment_identity');
    assert(u.pathname.startsWith(`/attachments/${channelId}/${a.id}/`), 'attachment_path_mismatch');
    return u;
}
export async function readBounded(response: Response, max: number): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isFinite(declared) || declared < 0 || declared > max) {
        await response.body?.cancel().catch(() => { });
        throw new AppError('response_byte_limit');
    }
    assert(response.body, 'empty_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            total += value.length;
            assert(total <= max, 'response_byte_limit');
            chunks.push(value);
        }
    }
    catch (e) {
        await reader.cancel().catch(() => { });
        throw e;
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}
export async function downloadAttachment(a: Attachment, channel: string, http: typeof fetch = fetch): Promise<NormalizedImage> {
    assert(a.size <= MAX_IMAGE_BYTES && a.size > 0, 'image_byte_limit');
    const url = attachmentURL(a, channel);
    let res: Response;
    try {
        res = await http(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
    }
    catch {
        throw new AppError('attachment_download_failed', 502);
    }
    assert(res.ok, 'attachment_download_failed', 502);
    return normalize(await readBounded(res, MAX_IMAGE_BYTES));
}
export class ObjectStore {
    readonly root: string;
    constructor(root: string) { this.root = resolve(root); }
    private path(key: string) { assert(/^[0-9]{6,22}\/[0-9a-f]{64}\.jpg$/.test(key), 'invalid_object_key'); const p = resolve(this.root, key); assert(p.startsWith(this.root + sep), 'invalid_object_key'); return p; }
    async put(guildId: string, image: NormalizedImage) {
        const key = `${guildId}/${image.sha256}.jpg`, p = this.path(key);
        await mkdir(dirname(p), { recursive: true, mode: 0o700 });
        const temporary = `${p}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, image.bytes, { mode: 0o600, flag: 'wx', flush: true });
            await rename(temporary, p);
        } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        return key;
    }
    async get(guildId: string, key: string) { assert(key.startsWith(guildId + '/'), 'cross_guild_object', 403); return readFile(this.path(key)); }
    async remove(guildId: string, key: string) { assert(key.startsWith(guildId + '/'), 'cross_guild_object', 403); await unlink(this.path(key)).catch(e => { if (e.code !== 'ENOENT')
        throw e; }); }
    async collect(guildId: string, keep: Set<string>) {
        assert(snowflake(guildId), 'invalid_guild');
        const dir = resolve(this.root, guildId);
        const files = await readdir(dir).catch(() => []);
        for (const f of files) {
            const key = `${guildId}/${f}`;
            if (!keep.has(key) && /^[0-9a-f]{64}\.jpg$/.test(f)) {
                const m = await stat(this.path(key));
                if (Date.now() - m.mtimeMs > 86400000)
                    await this.remove(guildId, key);
            }
        }
    }
}
