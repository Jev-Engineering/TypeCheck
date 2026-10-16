// Post-deployment checks against the public production origin. Read-only: it issues
// no authenticated, moderation, Discord REST or Jev requests.
// Env: PRODUCTION_URL, EXPECTED_COMMIT, EXPECTED_STORAGE, DISCORD_CLIENT_ID, TIMEOUT_SECONDS.
// Exit 0 = healthy, 1 = failed, 3 = healthy release but the published process is standby.
import { appendFileSync } from 'node:fs';

const origin = new URL(process.env.PRODUCTION_URL ?? '').origin;
const expected = process.env.EXPECTED_COMMIT || null;
const storage = process.env.EXPECTED_STORAGE || null;
const deadline = Date.now() + Number(process.env.TIMEOUT_SECONDS ?? 600) * 1000;
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); return ok; };
const get = async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'typecheck-deploy-verifier' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    return { status: r.status, headers: r.headers, body: await r.text() };
};
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Waits for the expected release, then up to 90 s more for it to win controller election.
async function waitForRelease() {
    let last = 'no response', servingSince = 0;
    while (Date.now() < deadline) {
        try {
            const h = await get(`${origin}/api/health`), body = json(h.body);
            last = `${h.status} ${h.body.slice(0, 120)}`;
            if (h.status === 200 && body && (!expected || body.release === expected)) {
                servingSince ||= Date.now();
                if (body.status === 'leader' || Date.now() - servingSince > 90000) return body;
            }
        } catch (e) { last = e.name; }
        await new Promise(r => setTimeout(r, 10000));
    }
    throw new Error(`release not serving before timeout: ${last}`);
}

let health;
try { health = await waitForRelease(); }
catch (e) { check('release serving', false, e.message); }
if (health) try {
    check('https origin', origin.startsWith('https://'), origin);
    check('release matches CI commit', !expected || health.release === expected, `${health.release} (expected ${expected ?? 'any'})`);
    check('object storage persisted', !storage || health.storage === storage, `${health.storage} (expected ${storage ?? 'new marker'})`);
    check('object storage writable', !expected || /^[0-9a-f]{32}$/.test(health.storage ?? ''), health.storage);
    const ready = await get(`${origin}/api/ready`), r = json(ready.body);
    check('readiness (database + controller)', ready.status === 200 && r?.status === 'ready', `${ready.status} ${ready.body.slice(0, 100)}`);
    check('api responses not cached', /no-store/.test(ready.headers.get('cache-control') ?? '') && ready.headers.get('cf-cache-status') !== 'HIT', ready.headers.get('cache-control'));
    const auth = await get(`${origin}/api/session`);
    check('unauthenticated api denied and uncached', auth.status === 401 && /no-store/.test(auth.headers.get('cache-control') ?? ''), `${auth.status} ${auth.headers.get('cache-control')}`);
    const page = await get(`${origin}/`);
    const scope = /src="(\/r\/[0-9a-z]+)\/activity\/src\/main\.js"/.exec(page.body)?.[1];
    check('activity page', page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? '') && /no-store/.test(page.headers.get('cache-control') ?? ''), `${page.status} ${page.headers.get('cache-control')}`);
    check('assets scoped to release', !expected || scope === `/r/${expected.slice(0, 12)}`, scope);
    for (const [path, type] of [['/activity/src/main.js', 'javascript'], ['/style.css', 'css'], ['/shared/domain.js', 'javascript'], ['/vendor/discord-sdk.js', 'javascript']]) {
        const a = await get(`${origin}${scope ?? ''}${path}`);
        check(`asset ${path}`, a.status === 200 && (a.headers.get('content-type') ?? '').includes(type) && a.body.length > 0, `${a.status} ${a.headers.get('content-type')}`);
    }
    if (process.env.DISCORD_CLIENT_ID) {
        const proxied = await get(`https://${process.env.DISCORD_CLIENT_ID}.discordsays.com/api/health`).catch(e => ({ status: 0, body: e.name }));
        check('discord activity proxy reaches release', proxied.status === 200 && (!expected || json(proxied.body)?.release === expected), `${proxied.status} ${proxied.body.slice(0, 100)}`);
    }
} catch (e) { check('request completed', false, e.name); }
const failed = checks.filter(c => !c.ok);
const standby = health?.status === 'standby';
const summary = ['| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.ok ? 'pass' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`), `| published controller | ${standby ? 'STANDBY' : 'leader'} | ${health?.status ?? 'unknown'} |`].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Production verification (${origin})\n\n${summary}\n`);
process.exit(failed.length ? 1 : standby ? 3 : 0);
