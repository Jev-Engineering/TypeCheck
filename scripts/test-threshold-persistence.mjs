/** Runs only against the disposable database selected by the integration runners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../dist/server/policy.js';
import { CONTENT_PRESETS } from '../dist/shared/content.js';
import { baseRecord, DEFAULT_SETTINGS } from '../dist/shared/domain.js';
export async function thresholdPersistence(store, pool, dialect, guild) {
  const bind = dialect === 'mysql' ? '?' : '$1';
  const encode = value => dialect === 'mysql' ? JSON.stringify(value) : value;
  try {
    const initial = await store.getSettings(guild);
    assert.deepEqual(initial.value.thresholds, DEFAULT_SETTINGS.thresholds);
    const legacy = { none: .95, review: .8, warn: .97, delete: .97, timeout: .99, kick: .999, ban: .999 };
    await store.putSettings(guild, { ...initial.value, thresholds: legacy }, initial.revision);
    const rawLegacy = (await pool.query(`SELECT settings FROM guilds WHERE id=${bind}`, [guild])).rows[0].settings;
    const reopened = new store.constructor(pool);
    assert.equal(JSON.stringify((await reopened.getSettings(guild)).value.thresholds), JSON.stringify(rawLegacy.thresholds));
    assert.deepEqual((await reopened.getSettings(guild)).value.thresholds, legacy);
    const r = { ...baseRecord(guild, randomUUID()), threshold: .812345, groupId: null, referenceId: null };
    await reopened.put('rules', r, 0);
    assert.equal((await store.get('rules', guild, r.id)).threshold, .812345);
    assert.equal((await store.all('rules', guild))[0].threshold, .812345);
    const content = { ...baseRecord(guild, randomUUID()), type: 'content', groupId: null, referenceId: null, threshold: .83, content: structuredClone(CONTENT_PRESETS[0].definition) };
    await reopened.put('rules', content, 0);
    assert.deepEqual(await store.get('rules', guild, content.id), content);
    assert.equal(fingerprint(await store.get('rules', guild, content.id), [], DEFAULT_SETTINGS), fingerprint(content, [], DEFAULT_SETTINGS));
    assert.equal(await store.get('rules', guild + '1', content.id), null);
    const missing = { ...baseRecord(guild, randomUUID()), groupId: null, referenceId: null };
    await store.put('rules', missing, 0);
    assert.equal((await reopened.get('rules', guild, missing.id)).threshold, .7);
    assert.equal((await reopened.all('rules', guild)).find(x => x.id === missing.id).threshold, .7);
    const partial = { ...initial.value, thresholds: { delete: .83 } };
    await pool.query(dialect === 'mysql' ? 'UPDATE guilds SET settings=? WHERE id=?' : 'UPDATE guilds SET settings=$1 WHERE id=$2', [encode(partial), guild]);
    const loaded = await reopened.getSettings(guild);
    assert.equal(loaded.value.thresholds.delete, .83);
    assert.equal(loaded.value.thresholds.timeout, .9);
    assert.equal(loaded.value.enforcement, false);
    // Defaults are applied on read, without rewriting persisted configuration.
    const raw = (await pool.query(`SELECT settings FROM guilds WHERE id=${bind}`, [guild])).rows[0].settings;
    assert.deepEqual(raw.thresholds, { delete: .83 });
    console.log(`${dialect}: threshold defaults, legacy/custom persistence and missing-only fallback passed`);
  } finally {
    await pool.query(`DELETE FROM moderation_rules WHERE guild_id=${bind}`, [guild]);
    await pool.query(`DELETE FROM guilds WHERE id=${bind}`, [guild]);
  }
}
