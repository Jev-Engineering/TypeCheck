import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { assert } from '../shared/domain.js';
import type { SqlPool } from './postgres.js';

// Backups live beside the reference images, on the persistent object volume.
export const BACKUP_SUBDIR = 'backups';
export interface BackupReceipt { file: string; sha256: string; tables: number; rows: number; takenAt: string }
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const ident = (name: string) => { assert(/^[A-Za-z0-9_]+$/.test(name), 'invalid_identifier'); return `\`${name}\``; };

// Writes a self-contained MySQL dump of the connected schema from one consistent snapshot.
// Values travel as hex. Binary columns keep their raw bytes; every other value (text, JSON,
// numbers, dates) travels as its utf8mb4 text form and is converted back from text on restore,
// because a bare hex literal in a numeric context is read as an integer (X'31' is 49, not 1).
// Restore with the mysql client or the hosting dashboard's SQL import.
export async function backupMySql(pool: SqlPool, dir: string, label: string): Promise<BackupReceipt> {
    assert(/^[a-z0-9-]{1,40}$/.test(label), 'invalid_backup_label');
    const c = await pool.connect();
    const lines: string[] = [];
    const takenAt = new Date().toISOString();
    let tables: string[] = [], rows = 0;
    try {
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); // next transaction only; the pooled session is unchanged
        await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        tables = (await c.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name")).rows.map(r => String(r.name));
        lines.push('-- TypeCheck database backup', `-- Taken: ${takenAt}`, `-- Label: ${label}`, `-- Tables: ${tables.length}`,
            'SET NAMES utf8mb4;', "SET time_zone = '+00:00';", 'SET FOREIGN_KEY_CHECKS = 0;');
        for (const table of tables) {
            const create = String((await c.query(`SHOW CREATE TABLE ${ident(table)}`)).rows[0]['Create Table']);
            // Generated columns are recomputed on restore and cannot be inserted.
            const columns = (await c.query("SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND COALESCE(generation_expression, '') = '' ORDER BY ordinal_position", [table])).rows
                .map(r => ({ name: String(r.name), text: !BINARY_TYPES.has(String(r.type).toLowerCase()) }));
            lines.push('', `DROP TABLE IF EXISTS ${ident(table)};`, `${create};`);
            const select = columns.map((col, i) => `HEX(CAST(${ident(col.name)} AS ${col.text ? 'CHAR CHARACTER SET utf8mb4' : 'BINARY'})) AS c${i}`).join(', ');
            const names = columns.map(col => ident(col.name)).join(', ');
            for (const row of (await c.query(`SELECT ${select} FROM ${ident(table)}`)).rows) {
                const values = columns.map((col, i) => {
                    const hex = row[`c${i}`];
                    if (hex === null) return 'NULL';
                    assert(typeof hex === 'string' && /^[0-9A-F]*$/.test(hex), 'invalid_backup_value');
                    return col.text ? `CONVERT(X'${hex}' USING utf8mb4)` : `X'${hex}'`;
                });
                lines.push(`INSERT INTO ${ident(table)} (${names}) VALUES (${values.join(', ')});`);
                rows++;
            }
        }
        await c.query('COMMIT');
    } catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    } finally { c.release?.(); }
    lines.push('', 'SET FOREIGN_KEY_CHECKS = 1;', '');
    const body = lines.join('\n');
    const file = `${takenAt.replace(/[:.]/g, '-')}-${label}.sql`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = resolve(dir, file), temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, body, { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, path);
    } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    return { file, sha256: createHash('sha256').update(body).digest('hex'), tables: tables.length, rows, takenAt };
}
