import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, G, G2 } from './helpers.js';
import { seedStarterReferences } from '../server/starter-references.js';
import { normalize, NORMALIZATION_HASH_VERSION } from '../server/images.js';
import { readFile } from 'node:fs/promises';
import type { ReferenceImage } from '../shared/domain.js';

test('starter references initialize once, preserve deletion, isolate guilds and use native normalized hashes', async t => {
    const f = await fixture(t);
    await Promise.all([seedStarterReferences(f.services, G2, process.cwd()), seedStarterReferences(f.services, G2, process.cwd())]);
    const images = await f.store.all<ReferenceImage>('images', G2);
    assert.equal(images.length, 33);
    assert.equal((await f.store.all('groups', G2)).length, 1);
    assert.equal((await f.store.all('rules', G2)).length, 0);
    assert.equal((await f.store.getSettings(G2)).value.enforcement, false);
    for (const image of images) {
        const normalized = await normalize(await readFile(`data/scams/images/${image.name}`));
        assert.equal(image.hashVersion, NORMALIZATION_HASH_VERSION);
        assert.equal(image.sha256, normalized.sha256);
        assert.deepEqual(await f.objects.get(G2, image.objectKey), normalized.bytes);
    }
    for (const image of images) await f.store.remove('images', G2, image.id, image.revision);
    const group = (await f.store.all('groups', G2))[0]!;
    await f.store.remove('groups', G2, group.id, group.revision);
    await seedStarterReferences(f.services, G2, process.cwd());
    assert.equal((await f.store.all('images', G2)).length, 0);
    await seedStarterReferences(f.services, G, process.cwd());
    assert.equal((await f.store.all('images', G)).length, 1);
    assert.equal(f.control.calls, 0);
});

test('failed starter import rolls back and can be retried', async t => {
    const f = await fixture(t);
    await assert.rejects(seedStarterReferences(f.services, G2, 'missing-starter-root'));
    assert.equal((await f.store.getSettings(G2)).revision, 1);
    assert.equal((await f.store.all('groups', G2)).length, 0);
    await seedStarterReferences(f.services, G2, process.cwd());
    assert.equal((await f.store.all('images', G2)).length, 33);
});
