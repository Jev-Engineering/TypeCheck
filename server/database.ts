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
    assert((await pool.query(`SELECT version FROM schema_migrations WHERE version=${placeholder}`, ['004'])).rowCount === 1, 'migration_004_required');
}
// `beforeChange` (MySQL only) runs while the migration lock is held and only when a
// migration is pending, so concurrent starters back up once, before the first schema change.
// `applied` lists the MySQL migrations this call performed.
export async function migrateDatabase<T = never>(pool: SqlPool, kind: 'mysql' | 'postgres', beforeChange?: () => Promise<T>): Promise<{ applied: string[]; before?: T }> {
    assert(!beforeChange || kind === 'mysql', 'backup_requires_mysql');
    const c = await pool.connect();
    const applied: string[] = [];
    let before: T | undefined;
    let locked = false;
    try {
        const file = kind === 'mysql' ? 'db/mysql/001_initial.sql' : 'db/001_initial.sql';
        const sql = await readFile(file, 'utf8');
        const upgrade = await readFile(kind === 'mysql' ? 'db/mysql/002_usage.sql' : 'db/002_usage.sql', 'utf8');
        const historical = await readFile(kind === 'mysql' ? 'db/mysql/003_historical.sql' : 'db/003_historical.sql', 'utf8');
        const packs = await readFile(kind === 'mysql' ? 'db/mysql/004_packs.sql' : 'db/004_packs.sql', 'utf8');
        if (kind === 'postgres') {
            await c.query('BEGIN');
            await c.query('SELECT pg_advisory_xact_lock(21474199,2)');
            await c.query(sql);
            if (!(await c.query("SELECT version FROM schema_migrations WHERE version='002'")).rowCount) await c.query(upgrade);
            if (!(await c.query("SELECT version FROM schema_migrations WHERE version='003'")).rowCount) await c.query(historical);
            if (!(await c.query("SELECT version FROM schema_migrations WHERE version='004'")).rowCount) await c.query(packs);
            await c.query('COMMIT');
        } else {
            const r = await c.query("SELECT GET_LOCK('typecheck:migrate',60) AS locked");
            assert(Number(r.rows[0].locked) === 1, 'migration_lock_unavailable'); locked = true;
            // This migration has no routines or semicolons in literals. DDL auto-commits;
            // each statement is restartable and the version receipt is written last.
            const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
            await c.query(statements[0]!);
            const pending = async (version: string) => !(await c.query('SELECT version FROM schema_migrations WHERE version=?', [version])).rowCount;
            const need001 = await pending('001'), need002 = await pending('002'), need003 = await pending('003'), need004 = await pending('004');
            if ((need001 || need002 || need003 || need004) && beforeChange) before = await beforeChange();
            if (need001) { for (const statement of statements.slice(1)) await c.query(statement); applied.push('001'); }
            if (need002) { for (const statement of upgrade.split(';').map(s => s.trim()).filter(Boolean)) await c.query(statement); applied.push('002'); }
            if (need003) { for (const statement of historical.split(';').map(s => s.trim()).filter(Boolean)) await c.query(statement); applied.push('003'); }
            if (need004) { for (const statement of packs.split(';').map(s => s.trim()).filter(Boolean)) await c.query(statement); applied.push('004'); }
        }
        return { applied, before };
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
