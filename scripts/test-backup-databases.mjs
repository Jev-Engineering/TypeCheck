// Pre-migration backup drill. Only runs against newly created disposable local databases.
// Populates the 001 schema, migrates with the production backup hook, restores the backup with
// the mysql client into a second database and compares every row byte-for-byte.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase, migrateDatabase, assertMigrated } from '../dist/server/database.js';
import { openMySqlPool } from '../dist/server/mysql-pool.js';
import { backupMySql } from '../dist/server/backup.js';
import { baseRecord } from '../dist/shared/domain.js';
import { extractReceipts, summarizeReceipts } from './migration-receipt.mjs';
assert.equal(process.env.ALLOW_DATABASE_TESTS, 'true');
const source = new URL(process.env.TEST_DATABASE_URL), target = new URL(process.env.RESTORE_DATABASE_URL);
for (const u of [source, target]) { assert.equal(u.protocol, 'mysql:'); assert.equal(u.hostname, '127.0.0.1'); }
assert.equal(source.pathname, '/backup_test'); assert.equal(target.pathname, '/backup_restore');
const container = process.env.MYSQL_CONTAINER;
assert.match(container ?? '', /^[0-9a-f]{12,64}$/);
const dir = await mkdtemp(join(tmpdir(), 'backup-drill-'));
const { pool, store } = await openDatabase(source.href);
const restored = await openMySqlPool(target.href);
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
// Every non-generated value of every table, as hex, in a stable order.
async function snapshot(p) {
    const out = {};
    for (const { name } of (await p.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name")).rows) {
        const cols = (await p.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [name])).rows.map(r => r.c);
        const rows = (await p.query(`SELECT ${cols.map((c, i) => `HEX(CAST(\`${c}\` AS BINARY)) AS v${i}`).join(', ')} FROM \`${name}\``)).rows;
        out[name] = rows.map(r => cols.map((_, i) => r[`v${i}`]).join('|')).sort();
    }
    return out;
}
try {
    // Populate the untouched 001 schema with JSON, unicode, NULL and binary-adjacent data.
    const initial = await readFile('db/mysql/001_initial.sql', 'utf8');
    for (const sql of initial.split(';').map(s => s.trim()).filter(Boolean)) await pool.query(sql);
    const g = '639510170001', g2 = '639510170002';
    const s = await store.getSettings(g); await store.getSettings(g2);
    await store.putSettings(g, { ...s.value, channels: ['123456789'] }, s.revision);
    const group = { ...baseRecord(g, randomUUID()), name: 'Backup drill — ünïcødé 🧪 \'quote\' "double" \\ back; semi' };
    await store.put('groups', group, 0);
    await store.reserveCall(g, 100); await store.addTokens(g, 77);
    const nonce = randomUUID(); await store.createNonce(nonce, 'https://example.invalid');
    const before = await snapshot(pool);
    assert.ok(Object.keys(before).length >= 10 && before.guilds.length === 2);
    // The hook runs once, under the migration lock, before any 002 change, even for concurrent starters.
    let calls = 0;
    const hook = async () => { calls++; eq((await pool.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='002'")).rows[0].n, '0'); return backupMySql(pool, dir, 'pre-migration'); };
    const results = await Promise.all([migrateDatabase(pool, 'mysql', hook), migrateDatabase(pool, 'mysql', hook)]);
    await assertMigrated(pool, 'mysql');
    eq(calls, 1);
    const receipt = results.map(r => r.before).find(Boolean);
    eq(results.flatMap(r => r.applied), ['002','003','004']);
    const candidate = 'a'.repeat(40);
    const receipts = results.flatMap((r, i) => extractReceipts({ data: [{ message: 'TYPECHECK_MIGRATION_RECEIPT_V1 ' + JSON.stringify({ event: 'database_migration', release: candidate, applied: r.applied, backup: r.before ?? null }) }] }, candidate, i ? 'PUBLISH' : 'PREVIEW'));
    assert.ok(summarizeReceipts(receipts).includes(receipt.sha256)); checks++;
    eq((await migrateDatabase(pool, 'mysql', hook)).applied, []); eq(calls, 1);
    const body = await readFile(join(dir, receipt.file));
    eq(createHash('sha256').update(body).digest('hex'), receipt.sha256);
    eq(receipt.tables, Object.keys(before).length);
    eq(receipt.rows, Object.values(before).reduce((n, rows) => n + rows.length, 0));
    // Restore with the stock client, exactly as an operator would.
    await new Promise((resolve, reject) => {
        const child = spawn('docker', ['exec', '-i', container, 'mysql', '-u' + decodeURIComponent(target.username), '-p' + decodeURIComponent(target.password), 'backup_restore'], { stdio: ['pipe', 'inherit', 'inherit'] });
        createReadStream(join(dir, receipt.file)).pipe(child.stdin);
        child.on('error', reject).on('exit', code => code === 0 ? resolve() : reject(new Error(`mysql restore exited ${code}`)));
    });
    eq(await snapshot(restored), before);
    eq((await restored.query("SELECT version FROM schema_migrations")).rows.map(r => r.version), ['001']);
    // The restored pre-migration copy upgrades again.
    eq((await migrateDatabase(restored, 'mysql')).applied, ['002','003','004']);
    console.log(`Backup drill: ${checks} assertions passed; ${receipt.tables} tables, ${receipt.rows} rows restored byte-for-byte from a consistent pre-migration snapshot; hook ran once under concurrent migration.`);
} finally { await pool.end(); await restored.end(); await rm(dir, { recursive: true, force: true }); }
