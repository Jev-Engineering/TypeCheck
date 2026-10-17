import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityAuth, HttpError } from '../activity/src/connection.js';

function flow() {
    const calls: string[] = [];
    let renewError: unknown, authorizeError: unknown;
    let next = 0;
    const connect = activityAuth({
        start: async () => { const n = `nonce-${++next}`; calls.push(n); return n; },
        authorize: async nonce => { calls.push(`authorize:${nonce}`); if (authorizeError) throw authorizeError; return `code-${nonce}`; },
        exchange: async (code, nonce) => { calls.push(`exchange:${code}:${nonce}`); return {sessionToken: 'initial', accessToken: 'oauth'}; },
        renew: async (token, nonce) => { calls.push(`renew:${token}:${nonce}`); if (renewError) throw renewError; return {sessionToken: 'renewed', accessToken: ''}; },
        authenticate: async () => { calls.push('authenticate'); },
        accessToken: auth => auth.accessToken
    });
    return {connect, calls, renewError: (error: unknown) => { renewError = error; }, authorizeError: (error: unknown) => { authorizeError = error; }};
}

test('expired application session reconnects without repeating SDK authorize or authenticate', async () => {
    const f = flow(); await f.connect(); assert.equal((await f.connect()).sessionToken, 'renewed');
    assert.deepEqual(f.calls, ['nonce-1','authorize:nonce-1','exchange:code-nonce-1:nonce-1','authenticate','nonce-2','renew:oauth:nonce-2']);
});

test('concurrent automatic and manual connects share one attempt', async () => {
    const f = flow(); const a = f.connect(), b = f.connect(); assert.equal(a, b); await a;
    assert.equal(f.calls.filter(c => c.startsWith('authorize:')).length, 1);
});

test('expired OAuth token falls back using a fresh nonce and code', async () => {
    const f = flow(); await f.connect(); f.renewError(new HttpError('discord_http_401', 401)); await f.connect();
    assert.deepEqual(f.calls.slice(4), ['nonce-2','renew:oauth:nonce-2','nonce-3','authorize:nonce-3','exchange:code-nonce-3:nonce-3','authenticate']);
});

test('plain SDK rejection explains the failed stage and retry remains possible', async () => {
    const f = flow(); f.authorizeError({code: 4001, message: 'SDK error'});
    await assert.rejects(f.connect(), /Discord authorization failed.*4001.*Connect in Discord/);
    f.authorizeError(undefined); await f.connect(); assert.ok(f.calls.includes('authorize:nonce-2'));
});

test('renewal permission or network failures do not start another OAuth flow', async () => {
    const f = flow(); await f.connect(); f.renewError(new HttpError('no_delegated_access', 403));
    await assert.rejects(f.connect(), /Session renewal failed.*403/);
    assert.equal(f.calls.filter(c => c.startsWith('authorize:')).length, 1);
});
