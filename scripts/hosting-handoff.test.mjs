import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('handoff is bounded, requires a leader and does not retry unrelated verification failures', { skip: process.platform === 'win32' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash
n=$(cat "$COUNT"); echo $((n+1)) > "$COUNT"
if [[ "$n" -ge "$SUCCEED_AFTER" ]]; then exit 0; fi
exit "$VERIFY_CODE"
`, { mode: 0o755 });
    writeFileSync(join(dir, 'gddy'), '#!/usr/bin/env bash\necho "$*" >> "$CALLS"\n', { mode: 0o755 });
    const calls = join(dir, 'calls'), count = join(dir, 'count');
    for (const [code, after, success, restarts] of [[3, 1, true, 1], [3, 2, true, 2], [3, 9, false, 2], [1, 9, false, 0], [0, 0, true, 0]]) {
        writeFileSync(calls, ''); writeFileSync(count, '0');
        const r = spawnSync('bash', [resolve('scripts/godaddy-release.sh'), 'verify'], { encoding: 'utf8', timeout: 5000,
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APP_ID: 'NODEJS-test', CALLS: calls, COUNT: count, VERIFY_CODE: String(code), SUCCEED_AFTER: String(after) } });
        assert.equal(r.status === 0, success, r.stderr);
        const invocations = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(invocations.length, restarts);
        for (const line of invocations) assert.equal(line, 'hosting app restart --app-id NODEJS-test --variant PREVIEW --output json');
    }
});

test('a rejected PREVIEW restart is retried and never skips re-verification', { skip: process.platform === 'win32' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'restart-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash
n=$(cat "$COUNT"); echo $((n+1)) > "$COUNT"
if [[ "$n" -ge "$SUCCEED_AFTER" ]]; then exit 0; fi
exit 3
`, { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\necho "$1" >> "$SLEEPS"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'gddy'), `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
n=$(wc -l < "$CALLS")
if [[ "$n" -le "$FAIL_RESTARTS" ]]; then echo '{"error":{"code":"NOT_FOUND","message":"HTTP error 404: App not found or failed to restart"}}'; exit 4; fi
`, { mode: 0o755 });
    const calls = join(dir, 'calls'), count = join(dir, 'count'), sleeps = join(dir, 'sleeps');
    // [failed restarts, verification succeeds after, success, restart calls, backoff sleeps]
    for (const [fail, after, success, restarts, backoff] of [[2, 1, true, 3, '15,30'], [4, 1, true, 4, '15,30,45'], [8, 9, false, 8, '15,30,45,15,30,45']]) {
        writeFileSync(calls, ''); writeFileSync(count, '0'); writeFileSync(sleeps, '');
        const r = spawnSync('bash', [resolve('scripts/godaddy-release.sh'), 'verify'], { encoding: 'utf8', timeout: 5000,
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APP_ID: 'NODEJS-test', CALLS: calls, COUNT: count, SLEEPS: sleeps, FAIL_RESTARTS: String(fail), SUCCEED_AFTER: String(after) } });
        assert.equal(r.status === 0, success, r.stdout + r.stderr);
        assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, restarts);
        assert.equal(readFileSync(sleeps, 'utf8').trim().split('\n').join(','), backoff);
        assert.match(r.stdout, /PREVIEW restart attempt 1 failed: .*failed to restart/);
    }
});

test('receipt retrieval is bounded and writes only validated evidence to workflow outputs', { skip: process.platform === 'win32' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'gddy'), '#!/usr/bin/env bash\necho "$*" >> "$CALLS"\ncat "$LOGS"\n', { mode: 0o755 });
    const candidate = 'a'.repeat(40), calls = join(dir, 'calls'), logs = join(dir, 'logs'), output = join(dir, 'output');
    const backup = { file: '2026-10-17T12-00-00-000Z-pre-migration.sql', sha256: 'b'.repeat(64), tables: 3, rows: 4, takenAt: '2026-10-17T12:00:00.000Z' };
    for (const [record, success, expectedCalls] of [
        [{ event: 'database_migration', release: candidate, applied: ['002'], backup }, true, 2],
        [{ event: 'database_migration', release: candidate, applied: [], backup: null }, true, 2],
        [null, false, 24],
        [{ event: 'database_migration', release: candidate, applied: ['002'], backup: null }, false, 1],
    ]) {
        writeFileSync(calls, ''); writeFileSync(output, '');
        writeFileSync(logs, JSON.stringify({ data: record ? [{ message: '[INFO] TYPECHECK_MIGRATION_RECEIPT_V1 ' + JSON.stringify(record) }] : [] }));
        const r = spawnSync('bash', [resolve('scripts/godaddy-release.sh'), 'receipt', '2026-10-17T00:00:00Z'], { encoding: 'utf8', timeout: 15000,
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APP_ID: 'NODEJS-test', CANDIDATE: candidate, CALLS: calls, LOGS: logs, GITHUB_OUTPUT: output } });
        assert.equal(r.status === 0, success, r.stderr);
        const invoked = readFileSync(calls, 'utf8').trim().split('\n');
        assert.equal(invoked.length, expectedCalls);
        for (const line of invoked) assert.match(line, /--source STDOUT --limit 500 --output json$/);
        if (success) assert.match(readFileSync(output, 'utf8'), /^backup=/);
        else assert.equal(readFileSync(output, 'utf8'), '');
    }
});
