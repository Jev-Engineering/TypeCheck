import test from 'node:test';
import assert from 'node:assert/strict';
import { Leadership, type LeaderStore, type Controller } from '../server/leadership.js';
import { databaseConfig } from '../server/config.js';
import { databaseKind } from '../server/database.js';
import { checkMySqlVersion } from '../server/mysql-pool.js';

function fixture() {
    let owner: (() => void) | null = null;
    const store: LeaderStore = { async acquireLeader(onLost) {
        if (owner) return null;
        owner = onLost;
        return async () => { owner = null; };
    } };
    let starts = 0, stops = 0;
    const create = (): Controller[] => Array.from({ length: 2 }, () => {
        let resolve: () => void;
        return { run: () => { starts++; return new Promise<void>(r => { resolve = r; }); }, stop: () => { stops++; resolve(); } };
    });
    return { store, create, lose: () => { const lost = owner; owner = null; lost?.(); }, get starts() { return starts; }, get stops() { return stops; } };
}
test('second instance stays standby; release permits takeover without overlapping controllers', async () => {
    const f = fixture(), fatal: string[] = [];
    const a = new Leadership(f.store, f.create, c => fatal.push(c), () => {});
    const b = new Leadership(f.store, f.create, c => fatal.push(c), () => {}, 5);
    try {
        await a.start(); await b.start();
        assert.equal(a.state, 'leader'); assert.equal(b.state, 'standby'); assert.equal(f.starts, 2);
        await a.stop(); assert.equal(f.stops, 2);
        for (let i = 0; i < 100 && b.state === 'standby'; i++) await new Promise(r => setTimeout(r, 5));
        assert.equal(b.state, 'leader'); assert.equal(f.starts, 4); assert.deepEqual(fatal, []);
    } finally { await a.stop(); await b.stop(); }
});
test('leadership loss stops Gateway and worker synchronously and never restarts them', async () => {
    const f = fixture(), fatal: string[] = [];
    const a = new Leadership(f.store, f.create, c => fatal.push(c), () => {});
    await a.start(); f.lose();
    assert.equal(a.state, 'lost'); assert.equal(f.stops, 2); assert.deepEqual(fatal, ['worker_leadership_lost']);
    await a.attempt(); assert.equal(f.starts, 2); await a.stop();
});
test('overlapping retries and shutdown during acquisition cannot create controllers', async () => {
    let complete!: (release: () => Promise<void>) => void, released = 0, starts = 0;
    const store: LeaderStore = { acquireLeader: () => new Promise(r => { complete = r; }) };
    const a = new Leadership(store, () => { starts++; return []; }, () => {}, () => {});
    const first = a.attempt(); assert.equal(a.attempt(), first);
    const stopped = a.stop(); complete(async () => { released++; });
    await Promise.all([first, stopped]); assert.equal(starts, 0); assert.equal(released, 1);
});
test('loss during acquisition never starts controllers', async () => {
    let starts = 0, released = 0;
    const a = new Leadership({ async acquireLeader(lost) { lost(); return async () => { released++; }; } },
        () => { starts++; return []; }, () => {}, () => {});
    await a.attempt(); assert.equal(a.state, 'lost'); assert.equal(starts, 0); assert.equal(released, 1);
});
test('a transient acquisition error remains retryable standby', async () => {
    let tries = 0, reports = 0;
    const a = new Leadership({ async acquireLeader() { if (++tries === 1) throw new Error('offline'); return async () => {}; } },
        () => [], () => {}, () => { reports++; });
    await a.attempt(); assert.equal(a.state, 'standby'); assert.equal(reports, 1);
    await a.attempt(); assert.equal(a.state, 'leader'); await a.stop();
});
test('MySQL minimum version rejects old servers, MariaDB and malformed values', () => {
    for (const v of ['8.0.16', '8.0.46', '8.4.0-commercial', '9.0.0']) checkMySqlVersion(v);
    for (const v of ['5.7.44', '8.0.15', '10.11.9-MariaDB', '5.5.5-10.6.0-MariaDB', 'unknown'])
        assert.throws(() => checkMySqlVersion(v), /mysql_8_0_16_required/);
});
test('database selection and GoDaddy variables preserve special characters without exposing them', () => {
    assert.equal(databaseKind('mysql://localhost/db'), 'mysql');
    assert.equal(databaseKind('postgresql://localhost/db'), 'postgres');
    assert.equal(databaseKind('postgres://localhost/db'), 'postgres');
    assert.throws(() => databaseKind('sqlite:/db'), /invalid_database_scheme/);
    const env = { DB_HOST: 'db.example.invalid', DB_PORT: '3306', DB_USER: 'test@user', DB_PASSWORD: 'test:/@#', DB_NAME: 'test/db', DB_SSL: '1', DB_SSL_CA: 'test-only-ca' };
    const c = databaseConfig(env), url = new URL(c.url);
    assert.equal(decodeURIComponent(url.password), env.DB_PASSWORD);
    assert.equal(decodeURIComponent(url.username), env.DB_USER);
    assert.equal(decodeURIComponent(url.pathname.slice(1)), env.DB_NAME);
    assert.deepEqual(c.tls, { ca: env.DB_SSL_CA });
    assert.equal(databaseConfig({ ...env, DATABASE_URL: 'postgres://localhost/db' }).url, 'postgres://localhost/db');
    assert.throws(() => databaseConfig({ ...env, DB_PORT: 'bad' }), /invalid_DB_PORT/);
    assert.throws(() => databaseConfig({ ...env, DB_SSL: '0' }), /DB_SSL_CA_requires_DB_SSL/);
});
