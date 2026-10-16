import { assert } from '../shared/domain.js';
import type { SqlClient, SqlPool, QueryResult } from './postgres.js';

export interface MySqlClient extends SqlClient { destroy(): void; }
export interface MySqlPool extends SqlPool { connect(): Promise<MySqlClient>; }
export interface MySqlTls { ca?: string; }
export function checkMySqlVersion(version: string) {
    const v = /^(\d+)\.(\d+)\.(\d+)(?:[-.]|$)/.exec(version);
    assert(v && !/mariadb/i.test(version) && (Number(v[1]) > 8 || (Number(v[1]) === 8 && (Number(v[2]) > 0 || Number(v[3]) >= 16))), 'mysql_8_0_16_required');
}
export async function openMySqlPool(connectionString: string, tls?: MySqlTls): Promise<MySqlPool> {
    const driverName = 'mysql2/promise';
    const { createPool } = await import(driverName);
    const url = new URL(connectionString);
    assert(url.protocol === 'mysql:', 'invalid_database_scheme');
    // Parse explicitly: URL query parameters must not override security/session options.
    assert(!url.search && !url.hash, 'mysql_url_options_not_supported');
    const raw = createPool({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 3306),
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: 5, queueLimit: 100, connectTimeout: 10000, timezone: 'Z', charset: 'utf8mb4_bin',
        flags: ['-FOUND_ROWS'], jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true,
        ssl: tls ? { ...tls, rejectUnauthorized: true } : undefined, multipleStatements: false });
    const connect = async (): Promise<MySqlClient> => {
        const c = await raw.getConnection();
        const query = async (sql: string, values: unknown[] = []): Promise<QueryResult> => {
            try {
                const [result] = await c.query({ sql, values, timeout: sql === "SELECT GET_LOCK('typecheck:migrate',60) AS locked" ? 65000 : 30000 });
                if (!Array.isArray(result)) return { rows: [], rowCount: result.affectedRows };
                // Decode JSON ourselves; never depend on the driver's implicit JSON type cast.
                for (const row of result) for (const key of ['settings', 'data', 'message'])
                    if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
                return { rows: result, rowCount: result.length };
            } catch (e) {
                // A timed-out command may still be executing; never return that socket to the pool.
                if ((e as { code?: string }).code === 'PROTOCOL_SEQUENCE_TIMEOUT') c.destroy();
                throw e;
            }
        };
        try {
            await query("SET time_zone='+00:00', SESSION sql_mode='STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', SESSION innodb_lock_wait_timeout=20");
            checkMySqlVersion(String((await query('SELECT VERSION() AS version')).rows[0].version));
        } catch (e) { c.destroy(); throw e; }
        return { query, release: () => c.release(), destroy: () => c.destroy(),
            on: (event, listener) => c.on(event, listener), removeListener: (event, listener) => c.removeListener(event, listener) };
    };
    const pool: MySqlPool = { connect, end: () => raw.end(), on: (event, listener) => raw.on(event, listener),
        query: async (sql, values) => { const c = await connect(); try { return await c.query(sql, values); } finally { c.release?.(); } } };
    try { const c = await connect(); c.release?.(); } catch (e) { await pool.end(); throw e; }
    return pool;
}
