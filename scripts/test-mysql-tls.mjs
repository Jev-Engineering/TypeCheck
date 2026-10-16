import assert from 'node:assert/strict';
import { openMySqlPool } from '../dist/server/mysql.js';
assert.equal(process.env.ALLOW_DATABASE_TESTS, 'true');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.protocol, 'mysql:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.ok(process.env.TEST_MYSQL_TLS_CA, 'Supply the disposable server public CA certificate.');
await assert.rejects(openMySqlPool(url.href, {}));
console.log('PASS: untrusted TLS certificate rejected.');
const pool = await openMySqlPool(url.href, { ca: process.env.TEST_MYSQL_TLS_CA });
try {
    const r = await pool.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.ok(r.rows[0].Value);
    console.log('PASS: trusted TLS connection with matching host identity and encrypted query.');
} finally { await pool.end(); }
