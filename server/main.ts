import { loadConfig } from './config.js';
import { openDatabase, assertMigrated, migrateDatabase } from './database.js';
import { Leadership } from './leadership.js';
import { Vault, safeError } from './security.js';
import { ObjectStore } from './images.js';
import { JevClient } from './jev.js';
import { DiscordRest } from './discord.js';
import { Gateway } from './gateway.js';
import { Services } from './services.js';
import { Worker } from './worker.js';
import { createHttp } from './http.js';
import { loadRelease } from './release.js';
import { type ReferenceImage } from '../shared/domain.js';
const report = (code: string) => console.error(JSON.stringify({ event: 'operational_error', code }));
async function main() {
    const config = loadConfig();
    const { pool, store, kind } = await openDatabase(config.databaseUrl, config.model, config.databaseTls);
    pool.on?.('error', () => report('database_pool_error'));
    if (config.migrateOnStart) await migrateDatabase(pool, kind);
    await assertMigrated(pool, kind);
    const discord = new DiscordRest(config.botToken, config.clientId, config.clientSecret);
    await discord.initialize();
    const objects = new ObjectStore(config.objectDir);
    const services = new Services(store, objects, new Vault(config.masterKey), new JevClient(), discord);
    const release = await loadRelease(process.cwd());
    const storage = await objects.marker().catch(() => { report('object_storage_unavailable'); return null; });
    const leadership = new Leadership(store, () => {
        const worker = new Worker(services, undefined, !config.production || config.enforcementApproved === true);
        const gateway = new Gateway(discord, config.botToken, m => worker.ingest(m), report);
        return [gateway, worker];
    }, code => { report(code); process.exit(1); }, report);
    const http = createHttp(services, config, process.cwd(), async () => {
        await pool.query('SELECT 1');
        return config.apiOnly || leadership.state === 'standby' || (leadership.state === 'leader' && discord.online);
    }, () => config.apiOnly ? 'api_only' : leadership.state, { release, storage });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '0.0.0.0', resolve); });
    console.log(JSON.stringify({ event: 'http_listening', port: config.port, version: '0.1.0', release: release?.commit ?? null, enforcementDefault: false }));
    let stopping = false;
    if (!config.apiOnly) await leadership.start();
    const maintenance = setInterval(() => { void (async () => { if (leadership.state !== 'leader') return; await store.maintenance(); for (const guild of await store.guilds()) {
        const images = await store.all<ReferenceImage>('images', guild);
        await services.objects.collect(guild, new Set(images.map(i => i.objectKey)));
    } })().catch(e => report(safeError(e))); }, 60 * 60000);
    const shutdown = async () => { if (stopping)
        return; stopping = true; clearInterval(maintenance); http.close(); const hardStop = setTimeout(() => process.exit(1), 30000); hardStop.unref(); await leadership.stop(); await pool.end(); process.exit(0); };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
}
void main().catch(e => { report(safeError(e)); process.exit(1); });
