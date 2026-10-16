import { loadConfig } from './config.js';
import { PostgresStore, openPool } from './postgres.js';
import { Vault, safeError } from './security.js';
import { ObjectStore } from './images.js';
import { JevClient } from './jev.js';
import { DiscordRest } from './discord.js';
import { Gateway } from './gateway.js';
import { Services } from './services.js';
import { Worker } from './worker.js';
import { createHttp } from './http.js';
import { assert, type ReferenceImage } from '../shared/domain.js';
const report = (code: string) => console.error(JSON.stringify({ event: 'operational_error', code }));
async function main() {
    const config = loadConfig();
    const pool = await openPool(config.databaseUrl);
    pool.on?.('error', () => report('database_pool_error'));
    assert((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', ['001'])).rowCount === 1, 'migration_001_required');
    const store = new PostgresStore(pool, undefined, config.model);
    const discord = new DiscordRest(config.botToken, config.clientId, config.clientSecret);
    await discord.initialize();
    const services = new Services(store, new ObjectStore(config.objectDir), new Vault(config.masterKey), new JevClient(), discord);
    const worker = new Worker(services, undefined, !config.production || config.enforcementApproved === true);
    const gateway = new Gateway(discord, config.botToken, m => worker.ingest(m), report);
    // Losing the dedicated advisory-lock connection stops this process; another worker
    // may then acquire leadership. Requests already sent cannot be recalled.
    const lostLeadership = () => { report('worker_leadership_lost'); gateway.stop(); worker.stop(); process.exit(1); };
    const release = config.apiOnly ? null : await store.acquireLeader(lostLeadership);
    assert(config.apiOnly || release, 'another_active_worker_holds_lock', 409);
    const http = createHttp(services, config, process.cwd(), async () => {
        await pool.query('SELECT 1');
        return config.apiOnly || discord.online;
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '0.0.0.0', resolve); });
    console.log(JSON.stringify({ event: 'http_listening', port: config.port, version: '0.1.0', enforcementDefault: false }));
    let stopping = false;
    const jobs = release ? [gateway.run(), worker.run()] : [];
    for (const job of jobs)
        void job.then(() => { if (!stopping) { report('background_loop_stopped'); process.exit(1); } }, e => { report(safeError(e)); process.exit(1); });
    const maintenance = setInterval(() => { void (async () => { await store.maintenance(); for (const guild of await store.guilds()) {
        const images = await store.all<ReferenceImage>('images', guild);
        await services.objects.collect(guild, new Set(images.map(i => i.objectKey)));
    } })().catch(e => report(safeError(e))); }, 60 * 60000);
    const shutdown = async () => { if (stopping)
        return; stopping = true; clearInterval(maintenance); gateway.stop(); worker.stop(); http.close(); const hardStop = setTimeout(() => process.exit(1), 30000); hardStop.unref(); await Promise.allSettled(jobs); if (release)
        await release(); await pool.end(); process.exit(0); };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
}
void main().catch(e => { report(safeError(e)); process.exit(1); });
