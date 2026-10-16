// Only the isolated Compose validation project invokes this drill.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { PostgresStore, openPool } from '/app/dist/server/postgres.js';
import { ObjectStore, normalize } from '/app/dist/server/images.js';
import { Vault } from '/app/dist/server/security.js';
import { baseRecord } from '/app/dist/shared/domain.js';
const mode = process.argv[2];
const pool = await openPool(process.env.DATABASE_URL);
const store = new PostgresStore(pool), objects = new ObjectStore(process.env.OBJECT_DIR);
const guild = '900000000000000001', other = '900000000000000002';
const credentialId = '00000000-0000-4000-8000-000000000001';
const vault = new Vault(process.env.CREDENTIAL_MASTER_KEY);
try {
  assert.equal(process.env.ACCEPTANCE_APPROVED, '0');
  assert.notEqual(process.getuid(), 0, 'Runtime must be non-root');
  if (mode === 'seed') {
    assert.equal((await store.getSettings(guild)).value.enforcement, false);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64');
    const img = await normalize(png), key = await objects.put(guild, img);
    await writeFile(objects.root+'/drill-key.txt', key);
    await store.put('credentials', {...baseRecord(guild, credentialId), encrypted: vault.encrypt(guild, 'offline-test-key')}, 0);
    await store.enqueue({guildId:guild, channelId:'900000000000000003', messageId:'900000000000000004', userId:'900000000000000005', bot:false, webhook:false, attachments:[]});
    assert.ok(await store.claim());
    assert.equal(await store.beginAction({guildId:guild,messageId:'900000000000000004',slot:'user',action:'timeout',status:'attempting',detail:'',createdAt:new Date().toISOString()}),true);
  } else {
    const key = await readFile(objects.root+'/drill-key.txt','utf8');
    assert.ok((await objects.get(guild,key)).length > 0);
    assert.equal((await stat(objects.root+'/'+key)).mode & 0o777, 0o600);
    await assert.rejects(objects.get(other,key),/cross_guild_object/);
    const credential = await store.get('credentials',guild,credentialId);
    assert.equal(vault.decrypt(guild,credential.encrypted),'offline-test-key');
    assert.throws(()=>vault.decrypt(other,credential.encrypted));
    assert.equal((await store.getSettings(guild)).value.enforcement,false);
    if (mode === 'recover') {
      const release = await store.acquireLeader(); assert.ok(release);
      const job = await store.claim(); assert.ok(job); assert.equal(job.guildId,guild);
      assert.equal((await store.actions(guild))[0].status,'unknown');
      assert.equal(await store.beginAction((await store.actions(guild))[0]),false);
      await store.finish(job.id,null); await release();
    } else {
      assert.equal((await store.actions(guild))[0].status,'unknown');
      assert.equal(await store.claim(),null);
    }
  }
  console.log(`PASS persistence ${mode}: non-root, enforcement disabled, private storage, credential recovery, durable ledger`);
} finally { await pool.end(); }
