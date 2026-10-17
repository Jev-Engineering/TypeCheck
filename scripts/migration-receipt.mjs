import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const prefix = 'TYPECHECK_MIGRATION_RECEIPT_V1 ';
const fail = () => { throw new Error('invalid_migration_receipt'); };
export function extractReceipts(response, candidate, variant) {
    if (!/^[a-f0-9]{40}$/.test(candidate) || !['PREVIEW', 'PUBLISH'].includes(variant) || !Array.isArray(response?.data)) fail();
    const found = [];
    for (const entry of response.data) {
        if (typeof entry?.message !== 'string') continue;
        const message = entry.message.replace(/^\[INFO\]\s*/, '');
        const framed = message.startsWith(prefix);
        let r;
        try { r = JSON.parse(framed ? message.slice(prefix.length) : message); }
        catch { if (framed) fail(); else continue; }
        if (r?.event !== 'database_migration' || r.release !== candidate) continue;
        if (!Array.isArray(r.applied) || r.applied.length > 100 || !r.applied.every(v => typeof v === 'string' && /^\d{3}$/.test(v)) || new Set(r.applied).size !== r.applied.length) fail();
        let backup = null;
        if (r.backup !== null) {
            const b = r.backup;
            if (!b || typeof b.file !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-pre-migration\.sql$/.test(b.file) ||
                typeof b.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.sha256) ||
                !Number.isSafeInteger(b.tables) || b.tables < 0 || !Number.isSafeInteger(b.rows) || b.rows < 0 ||
                typeof b.takenAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.takenAt) || !Number.isFinite(Date.parse(b.takenAt))) fail();
            backup = { file: b.file, sha256: b.sha256, tables: b.tables, rows: b.rows, takenAt: b.takenAt };
        }
        if (r.applied.length && !backup) fail();
        // Only operational metadata is allowed through; never print raw log records.
        found.push({ release: candidate, applied: r.applied, backup, variant });
    }
    return found;
}

export function summarizeReceipts(receipts) {
    if (!receipts.length) return null;
    const migrated = receipts.find(r => r.backup);
    if (migrated) {
        const b = migrated.backup;
        return `${b.file} (sha256 ${b.sha256}, ${b.tables} tables, ${b.rows} rows, ${migrated.variant})`;
    }
    // A single already-current starter cannot establish what happened in the other variant.
    if (['PREVIEW', 'PUBLISH'].every(v => receipts.some(r => r.variant === v)) && receipts.every(r => r.applied.length === 0))
        return 'schema already current in observed PREVIEW and PUBLISH starts; no backup reported by those starts';
    return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        let input = '';
        for await (const chunk of process.stdin) {
            input += chunk;
            if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('migration_log_response_too_large');
        }
        const [mode, candidate, variant] = process.argv.slice(2);
        if (mode === 'extract') {
            for (const r of extractReceipts(JSON.parse(input), candidate, variant)) console.log(JSON.stringify(r));
        } else if (mode === 'summary') {
            const receipts = input.trim() ? input.trim().split('\n').map(line => JSON.parse(line)) : [];
            // Revalidate even locally collected receipts before writing workflow outputs.
            const validated = receipts.flatMap(r => extractReceipts({ data: [{ message: JSON.stringify({ ...r, event: 'database_migration' }) }] }, candidate, r.variant));
            const summary = summarizeReceipts(validated);
            if (!summary) process.exitCode = 1;
            else {
                console.log(summary);
                if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `backup=${summary}\n`);
            }
        } else throw new Error('invalid_receipt_mode');
    } catch { console.error('migration_receipt_unavailable_or_invalid'); process.exitCode = 1; }
}
