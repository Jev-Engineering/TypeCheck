import { readFile } from 'node:fs/promises';
import { assert, DEFAULT_SETTINGS } from '../shared/domain.js';
import { openPool, PostgresStore, type SqlPool } from './postgres.js';
import { MySqlStore, openMySqlPool } from './mysql.js';
import type { MySqlPool, MySqlTls } from './mysql-pool.js';

export function databaseKind(url: string): 'mysql' | 'postgres' {
    const scheme = url.split(':', 1)[0] ?? '';
    assert(['mysql', 'postgres', 'postgresql'].includes(scheme), 'invalid_database_scheme');
    return scheme === 'mysql' ? 'mysql' : 'postgres';
}
export async function openDatabase(url: string, model = DEFAULT_SETTINGS.model, tls?: MySqlTls) {
    const kind = databaseKind(url);
    const pool = kind === 'mysql' ? await openMySqlPool(url, tls) : await openPool(url);
    const store = kind === 'mysql' ? new MySqlStore(pool as MySqlPool, undefined, model) : new PostgresStore(pool, undefined, model);
    return { kind, pool, store };
}
export async function assertMigrated(pool: SqlPool, kind: 'mysql' | 'postgres') {
    const placeholder = kind === 'mysql' ? '?' : '$1';
    assert((await pool.query(`SELECT version FROM schema_migrations WHERE version=${placeholder}`, ['001'])).rowCount === 1, 'migration_001_required');
}
export async function migrateDatabase(pool: SqlPool, kind: 'mysql' | 'postgres') {
    const c = await pool.connect();
    let locked = false;
    try {
        const file = kind === 'mysql' ? 'db/mysql/001_initial.sql' : 'db/001_initial.sql';
        const sql = await readFile(file, 'utf8');
        if (kind === 'postgres') {
            await c.query('BEGIN');
            await c.query('SELECT pg_advisory_xact_lock(21474199,2)');
            await c.query(sql);
            await c.query('COMMIT');
        } else {
            const r = await c.query("SELECT GET_LOCK('typecheck:migrate',60) AS locked");
            assert(Number(r.rows[0].locked) === 1, 'migration_lock_unavailable'); locked = true;
            // This migration has no routines or semicolons in literals. DDL auto-commits;
            // each statement is restartable and the version receipt is written last.
            const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
            await c.query(statements[0]!);
            if (!(await c.query("SELECT version FROM schema_migrations WHERE version='001'")).rowCount)
                for (const statement of statements.slice(1)) await c.query(statement);
        }
    } catch (e) {
        if (kind === 'postgres') await c.query('ROLLBACK');
        throw e;
    } finally {
        if (kind === 'mysql') {
            // Never return an uncertain named-lock connection to the pool.
            try { if (locked) await c.query("SELECT RELEASE_LOCK('typecheck:migrate')"); }
            finally { (c as import('./mysql-pool.js').MySqlClient).destroy(); }
        } else c.release?.();
    }
}
