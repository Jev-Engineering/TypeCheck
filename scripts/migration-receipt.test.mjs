import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReceipts, summarizeReceipts } from './migration-receipt.mjs';

const candidate = 'a'.repeat(40);
const receipt = { event: 'database_migration', release: candidate, applied: [], backup: null };
const backup = { file: '2026-10-17T12-00-00-000Z-pre-migration.sql', sha256: 'b'.repeat(64), tables: 8, rows: 10, takenAt: '2026-10-17T12:00:00.000Z' };
const extract = (r, variant = 'PREVIEW', prefix = '[INFO] TYPECHECK_MIGRATION_RECEIPT_V1 ') => extractReceipts({ data: [{ message: prefix + JSON.stringify(r) }] }, candidate, variant);

test('framed, platform-prefixed and legacy JSON receipts preserve only allowed metadata', () => {
    for (const prefix of ['', 'TYPECHECK_MIGRATION_RECEIPT_V1 ', '[INFO] TYPECHECK_MIGRATION_RECEIPT_V1 ']) {
        const records = extract({ ...receipt, applied: ['002'], backup: { ...backup, contents: 'private' }, secret: 'private' }, 'PREVIEW', prefix);
        assert.equal(records.length, 1); assert.equal(records[0].backup.sha256, backup.sha256);
        assert.doesNotMatch(JSON.stringify(records), /private|secret|contents/);
        assert.match(summarizeReceipts(records), /8 tables, 10 rows, PREVIEW/);
    }
});

test('already-current status requires both variants; partial, unrelated and missing evidence stays unknown', () => {
    assert.equal(summarizeReceipts([]), null);
    assert.equal(summarizeReceipts(extract(receipt)), null);
    assert.match(summarizeReceipts([...extract(receipt), ...extract(receipt, 'PUBLISH')]), /schema already current in observed/);
    assert.deepEqual(extract({ ...receipt, release: 'c'.repeat(40) }), []);
    assert.deepEqual(extractReceipts({ data: [{ message: '[INFO] database_migration' }, { message: 'unrelated' }] }, candidate, 'PUBLISH'), []);
    assert.throws(() => extractReceipts({}, candidate, 'PUBLISH'));
});

test('malformed or unsafe receipts never confirm backups or disclose raw content', () => {
    for (const patch of [{ applied: null }, { applied: ['002', '002'] }, { applied: ['002'] }, { backup: undefined }, { backup: {} },
        { backup: { ...backup, file: '../private.sql' } }, { backup: { ...backup, rows: -1 } },
        { backup: { ...backup, tables: 1.5 } }, { backup: { ...backup, sha256: 'bad' } },
        { backup: { ...backup, takenAt: 'bad' } }]) assert.throws(() => extract({ ...receipt, ...patch }), /invalid_migration_receipt/);
    assert.throws(() => extractReceipts({ data: [{ message: 'TYPECHECK_MIGRATION_RECEIPT_V1 {broken' }] }, candidate, 'PREVIEW'));
    assert.throws(() => extract(receipt, 'invalid'));
});
