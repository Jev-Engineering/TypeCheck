import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assert, DEFAULT_SETTINGS } from '../shared/domain.js';
import { CONTENT_PRESETS, CONTENT_VERSION } from '../shared/content.js';
import { PACK_FORMAT, type Pack, type PackComponent } from '../shared/packs.js';
import { packDigest } from './packs.js';
import { NORMALIZATION_HASH_VERSION } from './images.js';
export const STARTER_PACKS = [
    { id: 'reviewed-scam-references', name: 'Scam references', description: '33 owner-reviewed scam examples. Reference matching only; no measured model accuracy.' },
    { id: 'image-scam-analysis', name: 'Image scam analysis', description: 'Editable criteria, exclusions, readability and context gates. Supplied template; not evaluated.' },
    { id: 'combined-scam-setup', name: 'Combined scam setup', description: 'Separate reference-match and content-analysis rules. References do not condition the content prompt.' },
    { id: 'custom-template', name: 'Custom policy template', description: 'Adapt observable criteria and exclusions before testing and approving.' }
];
export function scamReferenceComponent(dependencies: string[] = []): PackComponent {
    return { id: 'reference-rule', kind: 'rules', name: 'Known scam reference match (review first)', dependencies, value: { type: 'group', referenceId: null, groupId: 'scam-references', mode: 'exact', threshold: .9, action: 'review', timeoutSeconds: 600, deleteMessage: false, priority: 1, enabled: false, automatic: false, secondVerification: true, reason: 'Review a match to owner-reviewed scam references' } };
}
export async function starterPack(root: string, id: string): Promise<Pack> {
    const starter = STARTER_PACKS.find(s => s.id === id);
    assert(starter, 'starter_not_found', 404);
    const pack: Pack = { format: PACK_FORMAT, id, version: '1.0.0', description: starter.description, compatibility: { app: '0.1.0', schema: '004', prompt: CONTENT_VERSION, model: DEFAULT_SETTINGS.model, normalization: NORMALIZATION_HASH_VERSION }, provenance: { source: 'TypeCheck supplied starter; reference images supplied and reviewed by project owner on 2026-10-17', redistribution: 'Supplied image redistribution rights are not established. MIT code licensing does not grant image rights.' }, components: [], assets: [], policy: null, evidence: [] };
    if (['reviewed-scam-references', 'combined-scam-setup'].includes(id)) {
        pack.components.push({ id: 'scam-references', kind: 'groups', name: 'Starter scams (user-reviewed)', dependencies: [], value: {} });
        const manifest = JSON.parse(await readFile(resolve(root, 'data/scams/manifest.json'), 'utf8'));
        for (const entry of manifest.images) {
            assert(/^images\/scam_[a-z0-9_]+\.(jpg|png)$/.test(entry.file), 'invalid_starter_path');
            const bytes = await readFile(resolve(root, 'data/scams', entry.file));
            assert(createHash('sha256').update(bytes).digest('hex') === entry.sha256, 'starter_checksum_mismatch');
            const asset = 'asset-' + entry.sha256, component = 'reference-' + entry.sha256.slice(0, 32);
            pack.assets.push({ id: asset, sha256: entry.sha256, base64: bytes.toString('base64') });
            pack.components.push({ id: component, kind: 'images', name: entry.file.slice(7), dependencies: ['scam-references'], value: { groupId: 'scam-references', enabled: true, asset } });
        }
    }
    if (id !== 'reviewed-scam-references') {
        const content = CONTENT_PRESETS.find(p => p.id === (id === 'custom-template' ? 'custom' : 'scams'))!.definition;
        pack.components.push({ id: 'analysis-definition', kind: 'definitions', name: id === 'custom-template' ? 'Custom observable policy' : 'Image scam analysis', dependencies: [], value: { content } });
        pack.components.push({ id: 'analysis-rule', kind: 'rules', name: id === 'custom-template' ? 'Custom policy (configure first)' : 'Image scam analysis (review first)', dependencies: [], value: { type: 'content', content, referenceId: null, groupId: null, mode: 'exact', threshold: .9, action: 'review', timeoutSeconds: 600, deleteMessage: false, priority: 0, enabled: false, automatic: false, secondVerification: true, reason: 'Review apparent scam content with visible context' } });
    }
    if (id === 'combined-scam-setup')
        pack.components.push(scamReferenceComponent(pack.components.filter(c => ['groups', 'images'].includes(c.kind)).map(c => c.id)));
    const digest = packDigest(pack);
    pack.evidence.push({ kind: 'template', digest, source: 'Bundled TypeCheck starter', details: { modelEvaluation: 'not performed', liveValidation: 'not performed', limitations: 'No accuracy claim, no held-out split, no destination approval.' } });
    if (pack.assets.length)
        pack.evidence.push({ kind: 'human_review', digest, source: 'data/scams/manifest.json and README.md', details: { reviewer: 'project owner', date: '2026-10-17', sampleCount: 33, scope: 'Owner labeled supplied images as scams. Collection is not asserted to be exclusively crypto-related.', dataset: 'Supplied positive examples only; no negative or held-out split.', assetDigests: pack.assets.map(a => a.sha256) } });
    return pack;
}
