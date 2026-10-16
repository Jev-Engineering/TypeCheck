import { readFile } from 'node:fs/promises';
import { safeError } from './security.js';
import { openPool } from './postgres.js';
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error('DATABASE_URL required');
    const pool = await openPool(url);
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(21474199,2)');
        await c.query(await readFile(new URL('../../db/001_initial.sql', import.meta.url), 'utf8').catch(() => readFile('db/001_initial.sql', 'utf8')));
        await c.query('COMMIT');
        console.log('Migration 001 applied.');
    }
    catch (e) {
        await c.query('ROLLBACK');
        throw e;
    }
    finally {
        c.release?.();
        await pool.end();
    }
}
void main().catch(e => { console.error(JSON.stringify({ event: "migration_failed", code: safeError(e) })); process.exit(1); });
