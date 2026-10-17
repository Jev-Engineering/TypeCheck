import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assert, baseRecord, type Group, type ReferenceImage } from '../shared/domain.js';
import { normalize } from './images.js';
import type { Services } from './services.js';

// Only pristine guilds are initialized. Advancing settings revision atomically
// makes deletion permanent and serializes concurrent first sign-ins across replicas.
export async function seedStarterReferences(services: Services, guild: string, root: string) {
    return services.store.withGuild(guild, async tx => {
        const settings = await tx.getSettings(guild);
        if (settings.revision !== 1 || (await tx.all('images', guild)).length ||
            (await tx.all('groups', guild)).length || (await tx.all('rules', guild)).length) return;
        const directory = resolve(root, 'data/scams');
        const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as {
            images: { file: string; sha256: string; bytes: number }[];
        };
        assert(manifest.images.length === 33, 'invalid_starter_manifest');
        const group: Group = { ...baseRecord(guild, randomUUID()), name: 'Starter scams (user-reviewed)' };
        await tx.put('groups', group, 0);
        for (const entry of manifest.images) {
            assert(/^images\/scam_[a-z0-9_]+\.(jpg|png)$/.test(entry.file), 'invalid_starter_path');
            const source = await readFile(resolve(directory, entry.file));
            assert(source.length === entry.bytes && createHash('sha256').update(source).digest('hex') === entry.sha256, 'starter_checksum_mismatch');
            const image = await normalize(source);
            const record: ReferenceImage = {
                ...baseRecord(guild, randomUUID()), name: entry.file.slice(7), groupId: group.id,
                enabled: true, createdBy: 'system-starter-references',
                objectKey: await services.objects.put(guild, image), sha256: image.sha256,
                hashVersion: image.hashVersion, bytes: image.bytes.length, width: image.width, height: image.height
            };
            await tx.put('images', record, 0);
        }
        await tx.putSettings(guild, settings.value, settings.revision);
        await services.audit(guild, 'system', 'starter_references.created', group.id,
            { count: manifest.images.length, reviewSource: 'project-owner', reviewedAt: '2026-10-17' }, tx);
    });
}
