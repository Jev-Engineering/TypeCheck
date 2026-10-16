// Disposable loopback database only. Runs the real entrypoint with fake Discord identity.
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, rm, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
assert.equal(process.env.ALLOW_DATABASE_TESTS, 'true');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.protocol, 'mysql:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
const root = process.cwd(), temporary = await realpath(tmpdir());
const cwd = await mkdtemp(join(temporary, 'typecheck-mysql-startup-'));
let child;
try {
    for (const dir of ['dist', 'db']) await cp(join(root, dir), join(cwd, dir), { recursive: true });
    await cp(join(root, 'package.json'), join(cwd, 'package.json'));
    await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), 'junction');
    const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const env = { ...process.env, DATABASE_URL: url.href, PORT: String(port), NODE_ENV: 'development', API_ONLY: '1',
        PUBLIC_ORIGIN: 'http://localhost:3000', DISCORD_CLIENT_ID: '100000000000000001', DISCORD_CLIENT_SECRET: 'offline-fixture-only',
        DISCORD_BOT_TOKEN: 'offline-fixture-only', CREDENTIAL_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', ACCEPTANCE_APPROVED: '0' };
    // Ensure inherited Node preload/settings cannot introduce a different network fixture.
    delete env.NODE_OPTIONS;
    const start = migrate => {
        let output = '';
        child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', pathToFileURL(join(root, 'tests/offline-discord.mjs')).href, 'dist/server/main.js'],
            { cwd, env: { ...env, MIGRATE_ON_START: migrate ? '1' : '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
        const done = new Promise(r => child.once('exit', code => r(code)));
        return { done, output: () => output };
    };
    // The caller supplies a new, empty schema: default-off must refuse startup.
    const off = start(false);
    const code = await Promise.race([off.done, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('startup_timeout')), 20000); t.unref(); })]);
    assert.notEqual(code, 0); assert.ok(off.output().includes('operational_error'));
    assert.ok(!off.output().includes('http_listening')); console.log('PASS: default-off refuses an unmigrated schema.');
    const on = start(true);
    let ready = false;
    for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw new Error('startup_failed');
        try { const r = await fetch(`http://127.0.0.1:${port}/api/ready`); if (r.ok) { ready = true; break; } } catch {}
        await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ready); assert.ok(on.output().includes('http_listening'));
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.status, 'api_only');
    console.log('PASS: MIGRATE_ON_START=1 migrates and serves HTTP without .env; Discord identity is offline fixture only.');
    child.kill(); await on.done; child = undefined;
} finally {
    if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; }
    assert.ok(resolve(cwd).startsWith(temporary + sep));
    await rm(cwd, { recursive: true, force: true });
}
