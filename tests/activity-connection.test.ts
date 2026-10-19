import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityAuth, apiResponse, connectionError, HttpError } from '../activity/src/connection.js';

test('missing TypeCheck role grant explains access requirements instead of retrying Discord authorization', () => {
    const error = connectionError('Authorization code exchange', new HttpError('no_delegated_access', 403));
    assert.match(error.message, /Server owners and members with Administrator or Manage Server/);
    assert.match(error.message, /TypeCheck → Permissions and grant access to your Discord role/);
    assert.doesNotMatch(error.message, /close and reopen|Discord continues rejecting/);
    assert.match(connectionError('Authorization code exchange', new HttpError('discord_http_403', 403)).message, /HTTP 403: discord_http_403/);
});

test('non-JSON proxy failures preserve HTTP status without displaying the response body', async () => {
    const response = new Response('<html>private upstream diagnostic</html>', {status: 502, headers: {'cf-ray': 'abc123-IAD'}});
    await assert.rejects(apiResponse(response), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        const message = connectionError('Authorization code exchange', error).message;
        assert.match(message, /HTTP 502: The server returned an unreadable response/);
        assert.match(message, /server or an upstream service returned an error/);
        assert.match(message, /reference abc123-IAD/);
        assert.doesNotMatch(message, /private upstream|Discord continues rejecting|need permission|grant access/);
        return true;
    });
});

test('server sign-in errors preserve a support reference without treating administrators as ungranted members', async () => {
    await assert.rejects(apiResponse(Response.json({error: 'internal_error', requestId: 'test-request-123'}, {status: 500})), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        const message = connectionError('Authorization code exchange', error).message;
        assert.match(message, /could not complete sign-in/);
        assert.match(message, /HTTP 500: internal_error; reference test-request-123/);
        assert.doesNotMatch(message, /need permission|grant access|close and reopen/);
        return true;
    });
});

test('API response parsing preserves permission failures and successful session data', async () => {
    await assert.rejects(apiResponse(Response.json({error: 'no_delegated_access'}, {status: 403})), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 403);
        assert.match(connectionError('Authorization code exchange', error).message, /TypeCheck → Permissions/);
        return true;
    });
    assert.deepEqual(await apiResponse(Response.json({sessionToken: 'test-session'})), {sessionToken: 'test-session'});
});

test('network failures are not described as Discord rejecting authorization', () => {
    const message = connectionError('Authorization code exchange', new TypeError('Failed to fetch')).message;
    assert.match(message, /server could not be reached/);
    assert.doesNotMatch(message, /Discord continues rejecting/);
});

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
    await assert.rejects(f.connect(), /Connect in Discord.*Discord authorization failed.*4001/);
    f.authorizeError(undefined); await f.connect(); assert.ok(f.calls.includes('authorize:nonce-2'));
});

test('renewal permission or network failures do not start another OAuth flow', async () => {
    const f = flow(); await f.connect(); f.renewError(new HttpError('no_delegated_access', 403));
    await assert.rejects(f.connect(), /You need permission.*TypeCheck → Permissions/);
    f.renewError(new TypeError('Failed to fetch'));
    await assert.rejects(f.connect(), /Session renewal failed.*server could not be reached/);
    assert.equal(f.calls.filter(c => c.startsWith('authorize:')).length, 1);
});
test('a server without the bot explains how to add it instead of reporting a server error', () => {
    const error = connectionError('Authorization code exchange', new HttpError('bot_not_in_server', 409));
    assert.match(error.message, /bot is not in this server yet/);
    assert.match(error.message, /Add to your server/);
    assert.doesNotMatch(error.message, /HTTP 409/);
});
