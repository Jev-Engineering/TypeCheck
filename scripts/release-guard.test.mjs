import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyMigration, classifyChanges, decide } from './release-guard.mjs';

test('shipped migration 002 is expand-only for both databases', async () => {
    for (const file of ['db/002_usage.sql', 'db/mysql/002_usage.sql'])
        assert.deepEqual(classifyMigration(await readFile(file, 'utf8')), { kind: 'expand' }, file);
});
test('destructive or in-place schema changes are not expand-only', () => {
    for (const sql of ['ALTER TABLE guilds ADD COLUMN x INT', 'DROP TABLE usage_daily', 'UPDATE guilds SET settings = NULL', 'DELETE FROM jobs', 'INSERT INTO guilds(id) VALUES (1)', 'CREATE INDEX i ON guilds(id)', 'RENAME TABLE a TO b'])
        assert.equal(classifyMigration(sql).kind, 'incompatible', sql);
    assert.equal(classifyMigration('CREATE TABLE IF NOT EXISTS t (id INT); CREATE INDEX t_id ON t(id); INSERT INTO t SELECT 1; INSERT INTO schema_migrations(version) VALUES(\'003\')').kind, 'expand');
});
test('editing or deleting a shipped migration is incompatible', () => {
    assert.equal(classifyChanges([{ status: 'M', path: 'db/001_initial.sql' }]).migrations, 'incompatible');
    assert.equal(classifyChanges([{ status: 'D', path: 'db/mysql/002_usage.sql' }]).migrations, 'incompatible');
    assert.equal(classifyChanges([{ status: 'M', path: 'server/http.ts' }]).migrations, 'none');
});
test('ordering: forward deploys proceed, older commits need an explicit compatible rollback', () => {
    const none = { migrations: 'none', files: [] }, expand = { migrations: 'expand', files: ['db/003.sql'] }, bad = { migrations: 'incompatible', files: ['db/003.sql'], reasons: ['x'] };
    assert.equal(decide({ relation: 'forward', rollback: false, changes: expand }).action, 'deploy');
    assert.equal(decide({ relation: 'forward', rollback: false, changes: bad }).proceed, false);
    assert.equal(decide({ relation: 'older', rollback: false, changes: none }).reason, 'candidate_older_than_live_release');
    assert.equal(decide({ relation: 'older', rollback: true, changes: expand }).action, 'rollback');
    assert.equal(decide({ relation: 'older', rollback: true, changes: bad }).reason, 'rollback_target_incompatible_with_live_schema');
    assert.equal(decide({ relation: 'diverged', rollback: true, changes: none }).proceed, false);
    assert.equal(decide({ relation: 'same', rollback: false, changes: none }).action, 'redeploy');
});
