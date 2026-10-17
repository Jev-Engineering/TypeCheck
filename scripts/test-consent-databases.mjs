/** Creates/removes only its own disposable containers. No production .env or shared workload mutation. */
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
for (const kind of ['postgres', 'mysql']) {
    const pg = kind === 'postgres', name = 'typecheck-consent49-' + kind + '-' + Date.now();
    const args = pg ? ['-e', 'POSTGRES_PASSWORD=consent-test-only', '-e', 'POSTGRES_DB=guard_test'] : ['-e', 'MYSQL_ROOT_PASSWORD=consent-test-only', '-e', 'MYSQL_DATABASE=guard_test'];
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::' + (pg ? '5432' : '3306'), ...args, pg ? 'postgres:16' : 'mysql:8.0');
    try {
        let ready = false;
        for (let n = 0; n < 90; n++) {
            try { docker('exec', name, ...(pg ? ['pg_isready', '-U', 'postgres'] : ['mysql', '-h127.0.0.1', '-uroot', '-pconsent-test-only', '-e', 'SELECT 1'])); ready = true; break; } catch {}
            await setTimeout(1000);
        }
        if (!ready) throw Error(name + ' not ready');
        const port = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports[pg ? '5432/tcp' : '3306/tcp'][0].HostPort;
        const url = (pg ? 'postgresql://postgres' : 'mysql://root') + ':consent-test-only@127.0.0.1:' + port + '/guard_test';
        for (const script of ['scripts/test-consent-persistence.mjs', 'scripts/test-pack-persistence.mjs', 'scripts/test-onboarding-databases.mjs', pg ? 'scripts/test-postgres.mjs' : 'scripts/test-mysql.mjs']) {
            const result = spawnSync(process.execPath, [script], { env: { ...process.env, TEST_DATABASE_URL: url, ALLOW_DATABASE_TESTS: 'true' }, stdio: 'inherit' });
            if (result.status !== 0) throw Error(kind + ': ' + script + ' failed');
        }
    } finally { docker('rm', '-f', name); }
}
