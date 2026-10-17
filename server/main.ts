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
import { backupMySql, BACKUP_SUBDIR } from './backup.js';
import { resolve } from 'node:path';
import { type ReferenceImage } from '../shared/domain.js';
const report = (code: string) => console.error(JSON.stringify({ event: 'operational_error', code }));
async function main() {
    const config = loadConfig();
    const { pool, store, kind } = await openDatabase(config.databaseUrl, config.model, config.databaseTls);
    pool.on?.('error', () => report('database_pool_error'));
    const release = await loadRelease(process.cwd());
    // Production database credentials exist only inside the GoDaddy runtime, so admitted
    // migrations run here, once, under the migrator's named lock. A release-admitted migration
    // first writes a full backup to persistent storage; if that fails, nothing is migrated.
    if (config.migrateOnStart || release?.migrate) {
        const backup = release?.migrate ? () => backupMySql(pool, resolve(config.objectDir, BACKUP_SUBDIR), 'pre-migration') : undefined;
        const result = await migrateDatabase(pool, kind, backup);
        // A plain-text envelope survives hosting log processors that collapse JSON to its event name.
        console.log('TYPECHECK_MIGRATION_RECEIPT_V1 ' + JSON.stringify({ event: 'database_migration', release: release?.commit ?? null, applied: result.applied, backup: result.before ?? null }));
    }
    await assertMigrated(pool, kind);
    const discord = new DiscordRest(config.botToken, config.clientId, config.clientSecret);
    await discord.initialize();
    const objects = new ObjectStore(config.objectDir);
    const services = new Services(store, objects, new Vault(config.masterKey), new JevClient(), discord);
    const storage = await objects.marker().catch(() => { report('object_storage_unavailable'); return null; });
    const leadership = new Leadership(store, () => {
        const worker = new Worker(services, undefined, !config.production || config.enforcementApproved === true);
        const gateway = new Gateway(discord, config.botToken, m => worker.ingest(m), report);
        return [gateway, worker];
    }, code => { report(code); process.exit(1); }, report, 5000, config.production || release ? 30000 : 0);
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
