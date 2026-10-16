import { safeError } from './security.js';
import { databaseConfig } from './config.js';
import { openDatabase, migrateDatabase } from './database.js';
async function main() {
    const config = databaseConfig();
    const { pool, kind } = await openDatabase(config.url, undefined, config.tls);
    try { await migrateDatabase(pool, kind); console.log('Migrations 001–002 applied or already present.'); }
    finally { await pool.end(); }
}
void main().catch(e => { console.error(JSON.stringify({ event: 'migration_failed', code: safeError(e) })); process.exit(1); });
