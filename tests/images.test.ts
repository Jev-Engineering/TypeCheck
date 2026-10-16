import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, attachmentURL, downloadAttachment, readBounded, supportedAttachment, MAX_IMAGE_BYTES } from '../server/images.js';
import { AppError } from '../shared/domain.js';
import { fixture, message, PNG, G, G2, CHANNEL } from './helpers.js';
test('small PNG becomes an upright baseline JPEG within Jev bounds', async () => { const n = await normalize(PNG); assert.equal(n.width, 768); assert.equal(n.height, 768); assert.equal(n.bytes[0], 0xff); assert.equal(n.bytes[1], 0xd8); assert.equal(n.sha256.length, 64); });
test('malformed image is rejected', async () => assert.rejects(normalize(Buffer.from('not an image'))));
test('SVG is not accepted as a moderation image', async () => assert.rejects(normalize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>'))));
test('image byte cap is enforced before decoding', async () => assert.rejects(normalize(Buffer.alloc(MAX_IMAGE_BYTES + 1)), (e: unknown) => e instanceof AppError && e.code === 'image_byte_limit'));
test('attachment parser accepts supported extension when MIME is missing', () => assert.equal(supportedAttachment({ ...message().attachments[0]!, contentType: null, filename: 'IMAGE.PNG' }), true));
test('text attachments are ignored', () => assert.equal(supportedAttachment({ ...message().attachments[0]!, contentType: 'text/plain', filename: 'notes.txt' }), false));
test('Discord CDN URL must match the event channel and attachment ID', () => { const a = message().attachments[0]!; assert.equal(attachmentURL(a, CHANNEL).protocol, 'https:'); assert.throws(() => attachmentURL(a, '100000000000000099')); });
for (const url of ['http://cdn.discordapp.com/attachments/1/2/x.png', 'https://127.0.0.1/x.png', 'https://cdn.discordapp.com.evil.test/x.png', 'file:///etc/passwd', 'https://user:pass@cdn.discordapp.com/x.png', 'https://cdn.discordapp.com:8443/x.png'])
    test(`untrusted download URL rejected: ${url}`, () => assert.throws(() => attachmentURL({ ...message().attachments[0]!, url }, CHANNEL)));
test('attachment download forbids redirects and applies timeout', async () => { const a = message().attachments[0]!; let checked = false; const n = await downloadAttachment(a, CHANNEL, (async (_u: unknown, init?: RequestInit) => { assert.equal(init!.redirect, 'error'); assert.ok(init!.signal); checked = true; return new Response(new Uint8Array(PNG)); }) as typeof fetch); assert.ok(checked); assert.equal(n.width, 768); });
test('streamed body cap does not trust missing Content-Length', async () => { let canceled = false; const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { canceled = true; } }); await assert.rejects(readBounded(new Response(stream), 10)); assert.ok(canceled); });
test('declared oversized response is rejected', async () => assert.rejects(readBounded(new Response('x', { headers: { 'content-length': '999999999' } }), 10)));
test('object storage isolates guilds and prevents path traversal', async (t) => { const f = await fixture(t); assert.ok((await f.objects.get(G, f.ref.objectKey)).length > 0); await assert.rejects(f.objects.get(G2, f.ref.objectKey)); await assert.rejects(f.objects.get(G, `${G}/../../etc/passwd`)); });
test('normalization is deterministic for identical inputs', async () => assert.equal((await normalize(PNG)).sha256, (await normalize(PNG)).sha256));
