import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { AppError, assert, type CipherEnvelope } from '../shared/domain.js';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
// Pre-rename product name, kept on purpose: it is the AES-GCM AAD, so changing it makes every stored credential undecryptable.
const AAD_PREFIX = 'jev-image-guard:v1';
export class Vault {
    private key: Buffer;
    constructor(base64: string) { this.key = Buffer.from(base64, 'base64'); assert(this.key.length === 32, 'master_key_must_be_32_bytes'); }
    encrypt(guildId: string, value: string): CipherEnvelope {
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', this.key, iv);
        c.setAAD(Buffer.from(`${AAD_PREFIX}:${guildId}`));
        const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final()]);
        return { version: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    }
    decrypt(guildId: string, e: CipherEnvelope): string {
        try {
            assert(e.version === 1, 'unsupported_envelope');
            const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
            d.setAAD(Buffer.from(`${AAD_PREFIX}:${guildId}`));
            d.setAuthTag(Buffer.from(e.tag, 'base64'));
            return Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]).toString('utf8');
        }
        catch {
            throw new AppError('credential_decryption_failed', 503);
        }
    }
}
export function safeError(error: unknown): string { return error instanceof AppError ? error.code : 'internal_error'; }
export function csvCell(value: unknown): string {
    let v = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(v))
        v = "'" + v;
    return '"' + v.replaceAll('"', '""') + '"';
}
