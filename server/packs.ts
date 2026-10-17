import { createHash, randomUUID } from 'node:crypto';
import { assert, baseRecord, object, onlyKeys, text, parseRule, parseSettings, CAPABILITIES, ADMIN_ONLY, DEFAULT_SETTINGS, type RecordBase, type ReferenceImage, type Rule, type Group, type RoleGrant, type Settings } from '../shared/domain.js';
import { parseContent, CONTENT_VERSION } from '../shared/content.js';
import { PACK_FORMAT, PACK_LIMITS, type Pack, type PackComponent, type PackKind, type PackSelection, type ImportOptions, type PackPreview } from '../shared/packs.js';
import { normalize, NORMALIZATION_HASH_VERSION, type NormalizedImage } from './images.js';
import type { Store } from './store.js';
import type { Services } from './services.js';
import sharp from 'sharp';
// A purpose-separated MAC shared by replicas, without persisting uploaded files.
export function canonical(value: any): string { return JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))); }
export const packHash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export const packDigest = (p: Pack) => packHash({ ...p, evidence: [] });
const portable = (id: string) => 'c-' + packHash(id).slice(0, 32);
const validId = (s: unknown): s is string => typeof s === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(s);
const kinds: PackKind[] = ['groups', 'images', 'definitions', 'rules'];
type Saved = RecordBase & {
    name: string;
    content?: unknown;
    packOrigin?: {
        pack: string;
        component: string;
        digest: string;
        baseline: string;
    };
};
type Receipt = RecordBase & {
    pack: string;
    versions: string[];
    components: Record<string, string>;
    baselines?: Record<string, string>;
    evidence?: Pack['evidence'];
    importedDigest?: string;
    policyBaseline?: string;
    sourceChanged?: boolean;
    provenance?: Pack['provenance'];
};
function policyValue(record: any) { const { id, guildId, revision, createdAt, updatedAt, packOrigin, ...value } = record; return value; }
function ruleValue(record: Rule) { const { approval, ...value } = policyValue(record); return value; }
async function snapshot(tx: Store, guild: string) {
    const records: Record<string, RecordBase[]> = {};
    for(const kind of [...kinds,'grants' as const,'packs' as const]) records[kind]=(await tx.all(kind,guild)).sort((a,b)=>a.id.localeCompare(b.id));
    return { settings: await tx.getSettings(guild), records };
}
export async function exportPack(services: Services, guild: string, selection: PackSelection): Promise<Pack> {
    assert(selection.complete === undefined || typeof selection.complete === 'boolean', 'invalid_selection');
    return services.store.withGuild(guild, async (tx) => {
        const snap = await snapshot(tx, guild), rows = snap.records;
        const byId = new Map<string, {
            kind: PackKind;
            row: any;
        }>();
        for (const kind of kinds)
            for (const row of rows[kind]!)
                byId.set(row.id, { kind, row });
        const selected = new Set<string>();
        const expandedGroups = new Set<string>();
        const add = (kind: PackKind, id: string, includeMembers = true) => {
            const entry = byId.get(id);
            assert(entry && entry.kind === kind, 'pack_component_not_found');
            if (selected.has(id)) {
                if(kind==='groups' && includeMembers && !expandedGroups.has(id)) {
                    expandedGroups.add(id);
                    for(const image of rows.images as ReferenceImage[]) if(image.groupId===id) add('images',image.id);
                }
                return;
            }
            selected.add(id);
            const r = entry.row;
            if (r.groupId)
                add('groups', r.groupId,kind==='rules' && r.type==='group');
            if (r.referenceId)
                add('images', r.referenceId);
            if(kind==='groups' && includeMembers) expandedGroups.add(id);
            if (kind === 'groups' && includeMembers || kind === 'rules' && r.type === 'group')
                for (const image of rows.images as ReferenceImage[])
                    if (image.groupId === (kind === 'groups' ? id : r.groupId))
                        add('images', image.id);
            if (kind === 'rules' && r.type === 'any_match')
                for (const image of rows.images!)
                    add('images', image.id);
        };
        if (selection.complete)
            for (const [id, e] of byId)
                add(e.kind, id);
        else {
            assert(Array.isArray(selection.components) && selection.components.length > 0 && selection.components.length <= PACK_LIMITS.components, 'select_pack_components');
            for (const s of selection.components)
                add(s.kind, s.id);
        }
        const settings = structuredClone(snap.settings.value), bindings: NonNullable<Pack['policy']>['bindings'] = [], grants: NonNullable<Pack['policy']>['grants'] = [];
        const binding = (id: string, kind: 'channel' | 'role', purpose: string) => { const key = kind + '-' + portable(id); if (!bindings.some(b => b.id === key))
            bindings.push({ id: key, kind, purpose }); return key; };
        const policy: Partial<Settings> = settings;
        // Seed markers describe local history, not portable policy.
        delete policy.textStartersInstalled;
        delete policy.onboardingStarters;
        for (const field of ['channels', 'excludedChannels', 'exemptRoles'] as const)
            policy[field] = settings[field].map(id => binding(id, field === 'exemptRoles' ? 'role' : 'channel', field));
        policy.logChannel = settings.logChannel ? binding(settings.logChannel, 'channel', 'logChannel') : null;
        if (selection.complete)
            for (const grant of rows.grants as RoleGrant[])
                grants.push({ role: binding(grant.roleId, 'role', 'delegated permissions'), capabilities: grant.capabilities });
        const assets: Pack['assets'] = [], components: PackComponent[] = [];
        for (const id of selected) {
            const { kind, row } = byId.get(id)!, deps: string[] = [];
            let value: Record<string, any>;
            if (kind === 'images') {
                const bytes = await services.objects.get(guild, row.objectKey), sha256 = createHash('sha256').update(bytes).digest('hex');
                assert(sha256 === row.sha256 && bytes.length === row.bytes, 'source_asset_integrity_failure');
                const asset = 'asset-' + sha256;
                if (!assets.some(a => a.id === asset))
                    assets.push({ id: asset, sha256, base64: bytes.toString('base64'), ...(row.hashVersion === NORMALIZATION_HASH_VERSION ? { normalized: row.hashVersion } : {}) });
                value = { enabled: row.enabled, groupId: row.groupId ? portable(row.groupId) : null, asset };
            }
            else if (kind === 'rules') {
                value = ruleValue(row);
                delete value.name;
                if (value.groupId)
                    value.groupId = portable(value.groupId);
                if (value.referenceId)
                    value.referenceId = portable(value.referenceId);
            }
            else
                value = kind === 'definitions' ? { content: parseContent(row.content) } : {};
            if (value.groupId)
                deps.push(value.groupId);
            if (value.referenceId)
                deps.push(value.referenceId);
            if (kind === 'rules' && ['group', 'any_match'].includes(row.type))
                for (const image of rows.images as ReferenceImage[])
                    if (selected.has(image.id) && (row.type === 'any_match' || image.groupId === row.groupId))
                        deps.push(portable(image.id));
            components.push({ id: portable(id), kind, name: row.name, dependencies: [...new Set(deps)].sort(), value });
        }
        const origins = (rows.packs as Receipt[]).filter(r => Object.values(r.components).some(id => selected.has(id)));
        const source = ['Administrator export; origin declarations are untrusted', ...origins.map(r => r.pack + ': ' + (r.provenance?.source ?? 'retained import receipt')), ...[...selected].some(id => byId.get(id)?.row.createdBy === 'system-starter-references') ? ['Includes project-owner-reviewed starter scam references; source data/scams/manifest.json; review date 2026-10-17'] : []].join('; ').slice(0, 2000);
        const p: Pack = { format: PACK_FORMAT, id: text(selection.name ?? 'policy-' + packHash([...selected].sort()).slice(0, 24), 80), version: text(selection.version ?? '1.0.0', 40), description: selection.complete ? 'Complete portable moderation policy' : 'Selected moderation components with required dependencies', compatibility: { app: '0.1.0', schema: '004', prompt: CONTENT_VERSION, model: settings.model, normalization: NORMALIZATION_HASH_VERSION }, provenance: { source: 'Administrator export; review rights before sharing', redistribution: 'Not established by export' }, components, assets, policy: { settings: policy, bindings, grants }, evidence: [] };
        assert(validId(p.id), 'invalid_pack_identity');
        p.provenance.source = source;
        // Retain source evidence with its original binding. Never re-sign or
        // silently rebind an imported claim to a newly exported configuration.
        p.evidence = origins.flatMap(r => r.evidence ?? []).slice(0, 50);
        assert(assets.reduce((n, a) => n + Buffer.from(a.base64, 'base64').length, 0) <= PACK_LIMITS.expanded, 'pack_expanded_limit');
        assert(Buffer.byteLength(JSON.stringify(p)) <= PACK_LIMITS.bytes, 'pack_byte_limit');
        await services.audit(guild, 'system', 'pack.exported', p.id, { digest: packDigest(p), count: components.length }, tx);
        return p;
    });
}
export async function validatePack(input: unknown): Promise<{
    pack: Pack;
    images: Map<string, NormalizedImage>;
}> {
    object(input);
    const queue: {
        v: any;
        depth: number;
    }[] = [{ v: input, depth: 0 }];
    let nodes = 0;
    while (queue.length) {
        const { v, depth } = queue.pop()!;
        assert(++nodes <= 100000 && depth <= 32, 'pack_structure_limit');
        if (v && typeof v === 'object')
            for (const item of Object.values(v))
                queue.push({ v: item, depth: depth + 1 });
    }
    assert(Buffer.byteLength(JSON.stringify(input)) <= PACK_LIMITS.bytes, 'pack_byte_limit');
    const p = object(input);
    onlyKeys(p, ['format', 'id', 'version', 'description', 'compatibility', 'provenance', 'components', 'assets', 'policy', 'evidence']);
    assert(p.format === PACK_FORMAT, 'unsupported_pack_version');
    assert(validId(p.id), 'invalid_pack_identity');
    text(p.version, 40);
    text(p.description, 2000);
    const compat = object(p.compatibility);
    onlyKeys(compat, ['app', 'schema', 'prompt', 'model', 'normalization']);
    assert(compat.app === '0.1.0' && compat.schema === '004' && compat.prompt === CONTENT_VERSION, 'incompatible_pack');
    text(compat.normalization, 200);
    parseSettings({ model: compat.model });
    const provenance = object(p.provenance);
    onlyKeys(provenance, ['source', 'redistribution']);
    text(provenance.source, 2000);
    text(provenance.redistribution, 2000);
    assert(Array.isArray(p.assets) && p.assets.length <= PACK_LIMITS.assets && Array.isArray(p.components) && p.components.length <= PACK_LIMITS.components, 'pack_count_limit');
    const images = new Map<string, NormalizedImage>();
    let expanded = 0;
    for (const entry of p.assets) {
        const a = object(entry);
        onlyKeys(a, ['id', 'sha256', 'base64', 'normalized']);
        assert(validId(a.id) && !images.has(a.id), 'invalid_asset_id');
        assert(typeof a.base64 === 'string' && a.base64.length <= 11184812 && a.base64.length % 4 === 0, 'invalid_asset_encoding');
        const bytes = Buffer.from(a.base64, 'base64');
        assert(bytes.toString('base64') === a.base64, 'invalid_asset_encoding');
        expanded += bytes.length;
        assert(expanded <= PACK_LIMITS.expanded, 'pack_expanded_limit');
        assert(createHash('sha256').update(bytes).digest('hex') === a.sha256, 'asset_checksum_mismatch');
        let image = await normalize(bytes);
        if (a.normalized === NORMALIZATION_HASH_VERSION) {
            const m = await sharp(bytes, { limitInputPixels: 24000000, failOn: 'error' }).metadata();
            assert(m.format === 'jpeg' && m.width === 768 && m.height === 768 && !m.exif && !m.icc && !m.iptc && !m.xmp && !m.orientation, 'invalid_normalized_asset');
            image = { bytes, sha256: a.sha256 as string, width: 768, height: 768, hashVersion: NORMALIZATION_HASH_VERSION };
        }
        else
            assert(a.normalized === undefined || typeof a.normalized === 'string' && a.normalized.length <= 200, 'invalid_normalization_version');
        images.set(a.id, image);
    }
    const components = p.components as PackComponent[], ids = new Map<string, PackComponent>();
    for (const entry of components) {
        const c = object(entry);
        onlyKeys(c, ['id', 'kind', 'name', 'dependencies', 'value']);
        assert(validId(c.id) && !ids.has(c.id) && kinds.includes(c.kind as PackKind), 'invalid_component');
        text(c.name);
        assert(Array.isArray(c.dependencies) && c.dependencies.length <= 600 && c.dependencies.every(validId), 'invalid_dependencies');
        object(c.value);
        ids.set(c.id, entry);
    }
    const fake = '11111111-1111-4111-8111-111111111111';
    for (const c of components) {
        assert(c.dependencies.every(d => ids.has(d)), 'dangling_dependency');
        const v = c.value;
        const dependency = (id: any, kind: PackKind) => { assert(id === null || validId(id) && ids.get(id)?.kind === kind && c.dependencies.includes(id), 'missing_required_dependency'); };
        if (c.kind === 'groups')
            onlyKeys(v, []);
        if (c.kind === 'definitions') {
            onlyKeys(v, ['content']);
            parseContent(v.content);
        }
        if (c.kind === 'images') {
            onlyKeys(v, ['asset', 'enabled', 'groupId']);
            assert(images.has(v.asset) && typeof v.enabled === 'boolean', 'invalid_image_component');
            dependency(v.groupId, 'groups');
        }
        if (c.kind === 'rules') {
            dependency(v.groupId, 'groups');
            dependency(v.referenceId, 'images');
            parseRule({ ...v, name: c.name, groupId: v.groupId ? fake : null, referenceId: v.referenceId ? fake : null });
            if (v.type === 'group' || v.type === 'any_match')
                for (const image of components.filter(i => i.kind === 'images' && (v.type === 'any_match' || i.value.groupId === v.groupId)))
                    assert(c.dependencies.includes(image.id), 'missing_required_dependency');
        }
        const expected = c.kind === 'images' ? [v.groupId].filter(Boolean) : c.kind === 'rules' ? [v.referenceId, v.groupId, ...components.filter(i => i.kind === 'images' && (v.type === 'any_match' || v.type === 'group' && i.value.groupId === v.groupId)).map(i => i.id)].filter(Boolean) : [];
        assert(c.dependencies.length === new Set(c.dependencies).size && c.dependencies.every(d => expected.includes(d)), 'unexpected_dependency');
    }
    if (p.policy !== null) {
        const policy = object(p.policy);
        onlyKeys(policy, ['settings', 'bindings', 'grants']);
        assert(Array.isArray(policy.bindings) && policy.bindings.length <= 1000 && Array.isArray(policy.grants) && policy.grants.length <= 250, 'invalid_policy_bindings');
        const bindings = new Map<string, string>();
        for (const raw of policy.bindings) {
            const b = object(raw);
            onlyKeys(b, ['id', 'kind', 'purpose']);
            assert(validId(b.id) && !bindings.has(b.id) && ['channel', 'role'].includes(b.kind as string), 'invalid_binding');
            text(b.purpose, 200);
            bindings.set(b.id, b.kind as string);
        }
        const s = object(policy.settings), mapped = { ...s };
        assert(!('textStartersInstalled' in s) && !('onboardingStarters' in s), 'starter_marker_not_portable');
        for (const k of ['channels', 'excludedChannels', 'exemptRoles']) {
            assert(Array.isArray(s[k]) && s[k].length <= 250 && s[k].every((id: any) => bindings.get(id) === (k === 'exemptRoles' ? 'role' : 'channel')), 'invalid_policy_binding');
            mapped[k] = [];
        }
        assert(s.logChannel === null || bindings.get(s.logChannel as string) === 'channel', 'invalid_policy_binding');
        mapped.logChannel = null;
        parseSettings(mapped);
        for (const raw of policy.grants) {
            const g = object(raw);
            onlyKeys(g, ['role', 'capabilities']);
            assert(bindings.get(g.role as string) === 'role' && Array.isArray(g.capabilities) && g.capabilities.length <= CAPABILITIES.length && g.capabilities.every(c => CAPABILITIES.includes(c) && !ADMIN_ONLY.includes(c)), 'invalid_grant');
        }
    }
    assert(Array.isArray(p.evidence) && p.evidence.length <= 50, 'invalid_evidence');
    for (const raw of p.evidence) {
        const e = object(raw);
        onlyKeys(e, ['kind', 'digest', 'source', 'details']);
        assert(['template', 'human_review', 'software', 'model_evaluation', 'live'].includes(e.kind as string), 'invalid_evidence_kind');
        assert(typeof e.digest === 'string' && /^[a-f0-9]{64}$/.test(e.digest), 'invalid_evidence_digest');
        text(e.source, 2000);
        assert(Buffer.byteLength(JSON.stringify(object(e.details))) <= 20000, 'evidence_limit');
    }
    return { pack: p as unknown as Pack, images };
}
function mac(services: Services, value: unknown) { return services.vault.packPreviewMac(canonical(value)); }
export class Packs {
    constructor(readonly services: Services) { }
    async authority(guild: string, actor: string) { const a = await this.services.authority(guild, actor); assert(a.owner || a.administrator, 'administrator_required', 403); }
    async history(guild: string, actor: string) {
        await this.authority(guild, actor);
        return this.services.store.withGuild(guild, async (tx) => {
            const snap = await snapshot(tx, guild);
            return (snap.records.packs as Receipt[]).map(r => ({ id: r.pack, versions: r.versions, digest: r.importedDigest, evidence: r.evidence ?? [], status: r.sourceChanged || Object.entries(r.baselines ?? {}).some(([id, digest]) => { const row = kinds.flatMap(k => snap.records[k]!).find(x => x.id === id); return !row || packHash(policyValue(row)) !== digest; }) || r.policyBaseline && packHash(snap.settings.value) !== r.policyBaseline ? 'stale: destination differs from source or import baseline' : 'historical; untrusted; no destination approval' }));
        });
    }
    async mapping(guild: string, actor: string, pack: Pack, options: ImportOptions) {
        if (!options.policy || !pack.policy)
            return;
        const meta = await this.services.discord.metadata(guild);
        for (const b of pack.policy.bindings) {
            const id = options.mappings?.[b.id];
            assert(id && (b.kind === 'channel' ? meta.channels : meta.roles).some(row => row.id === id), 'destination_mapping_required');
            if (b.kind === 'channel') {
                await this.services.discord.assertCanReadMessage(guild, actor, id);
                await this.services.discord.assertCanReadMessage(guild, this.services.discord.botId, id);
            }
        }
        if (pack.policy.settings.logChannel)
            await this.services.discord.assertCanNotify?.(guild, options.mappings![pack.policy.settings.logChannel]!);
    }
    private async plan(tx: Store, guild: string, pack: Pack, options: ImportOptions) {
        const snap = await snapshot(tx, guild), receipts = snap.records.packs as Receipt[];
        const receipt = receipts.find(r => r.pack === pack.id);
        const legacySeed = !receipts.some(r => r.pack === 'reviewed-scam-references') && ['reviewed-scam-references', 'combined-scam-setup'].includes(pack.id) && (await tx.all<any>('audit', guild)).some(r => r.event === 'starter_references.created');
        const result = pack.components.map(c => {
            const origin = (snap.records[c.kind] as Saved[]).find(r => r.packOrigin?.pack === pack.id && r.packOrigin.component === c.id);
            const prior = receipt && Object.hasOwn(receipt.components,c.id) ? receipt.components[c.id] : undefined;
            const seed = receipts.find(r => r.pack === 'reviewed-scam-references');
            const seedId = seed && Object.hasOwn(seed.components,c.id) ? seed.components[c.id] : undefined;
            let existing = origin ?? (snap.records[c.kind] as Saved[]).find(r => r.id === prior || r.id === seedId);
            if (!existing && legacySeed && c.kind === 'groups' && c.id === 'scam-references')
                existing = (snap.records.groups as Saved[]).find(r => r.name === 'Starter scams (user-reviewed)');
            // Adopt existing first-login assets by normalized digest, preserving edits/group assignment.
            if (!existing && c.kind === 'images')
                existing = (snap.records.images as unknown as ReferenceImage[]).find(r => r.sha256 === c.value.normalizedDigest) as unknown as Saved;
            const onboardingDeleted = pack.id === 'combined-scam-setup' && c.id === 'reference-rule' && snap.settings.value.onboardingStarters?.includes('image_scams');
            const deleted = !existing && (prior || seedId || legacySeed && c.kind === 'images' || onboardingDeleted);
            const baseline = origin?.packOrigin?.baseline ?? (existing && receipt?.baselines?.[existing.id]);
            const edited = existing && baseline && packHash(policyValue(existing)) !== baseline;
            const original = structuredClone(c);
            delete original.value.normalizedDigest;
            const status = deleted ? 'previously deleted' : edited ? 'locally edited' : existing ? (origin?.packOrigin?.digest === packHash(original) ? 'already imported' : 'conflict / upgrade') : 'addition';
            const explicit = options.choices && Object.hasOwn(options.choices,c.id) ? options.choices[c.id] : undefined;
            const choice = deleted && !options.restoreDeleted ? 'keep' : existing ? explicit ?? 'keep' : 'add';
            return { c, existing, status, choice };
        });
        // A missing dependency is a visible keep/skip, never an implicit restoration.
        for(const r of result) if(r.choice !== 'keep' && r.c.kind === 'rules' && r.c.value.type === 'group') {
            const group=result.find(d=>d.c.id===r.c.value.groupId)!;
            if(result.some(d=>r.c.dependencies.includes(d.c.id) && d.c.kind==='images' && d.existing && d.choice==='keep' && (d.existing as unknown as ReferenceImage).groupId !== group.existing?.id)) {
                r.choice='keep';r.status='blocked: kept reference belongs to another destination group; choose replacement explicitly';
            }
        }
        for (let pass = 0; pass < result.length; pass++) {
            let changed = false;
            for (const r of result)
                if (r.choice !== 'keep' && r.c.dependencies.some(id => { const d = result.find(d => d.c.id === id)!; return !d.existing && d.choice === 'keep'; })) {
                    r.choice = 'keep';
                    r.status = 'blocked by a previously deleted dependency';
                    changed = true;
                }
            if (!changed)
                break;
        }
        return { snap, receipt, result };
    }
    async preview(guild: string, actor: string, input: unknown, options: ImportOptions = {}): Promise<PackPreview> {
        await this.authority(guild, actor);
        const { pack, images } = await validatePack(input);
        this.options(options);
        await this.mapping(guild, actor, pack, options);
        const prepared = structuredClone(pack);
        for (const c of prepared.components)
            if (c.kind === 'images')
                c.value.normalizedDigest = images.get(c.value.asset)!.sha256;
        return this.services.store.withGuild(guild, async (tx) => {
            const plan = await this.plan(tx, guild, prepared, options), digest = packDigest(pack), expires = Date.now() + 10 * 60000;
            const token = expires + '.' + mac(this.services, { guild, actor, digest: packHash(pack), options, snapshot: packHash(plan.snap), expires });
            return { token, digest, pack: { id: pack.id, version: pack.version, description: pack.description }, components: plan.result.map(r => ({ id: r.c.id, kind: r.c.kind, name: r.c.name, status: r.status, choice: r.choice, dependencies: r.c.dependencies })), bindings: pack.policy?.bindings ?? [], warnings: ['Imported rules require destination approval; automatic enforcement is off.', 'Evidence is an untrusted historical declaration, never destination approval.', 'Keep preserves existing records and local edits. Replacement invalidates approval.', ...(pack.policy ? ['Policy settings and delegated permissions apply only when explicitly selected and mapped. Imported global enforcement and high-impact actions stay off.'] : []), ...(pack.compatibility.normalization !== NORMALIZATION_HASH_VERSION ? ['Normalization version differs; assets will be normalized locally.'] : [])], evidence: pack.evidence.map(e => ({ kind: e.kind, status: e.digest === digest ? 'digest bound; untrusted declaration' : 'stale; configuration changed', source: e.source })), intendedRules: pack.components.filter(c => c.kind === 'rules').map(c => ({ name: c.name, policy: { ...c.value, name: c.name } as any })), intendedSettings: pack.policy?.settings ?? null, policyChanges: Object.entries(pack.policy?.settings ?? {}).filter(([k, v]) => canonical(v) !== canonical(plan.snap.settings.value[k as keyof Settings])).map(([setting, intended]) => ({ setting, destination: plan.snap.settings.value[setting as keyof Settings], intended })), grants: (pack.policy?.grants ?? []).map(g => { const role = options.mappings?.[g.role] ?? g.role, existing = (plan.snap.records.grants as RoleGrant[]).find(r => r.roleId === role); return { role, capabilities: g.capabilities, status: existing ? (canonical(existing.capabilities) === canonical(g.capabilities) ? 'keep existing' : 'conflict: reconcile in Permissions before applying policy') : 'addition (requires explicit policy application)' }; }) };
        });
    }
    private options(o: ImportOptions) { onlyKeys(object(o), ['choices', 'mappings', 'policy', 'restoreDeleted']); if (o.choices)
        assert(Object.values(object(o.choices)).every(v => ['keep', 'replace'].includes(v as string)), 'invalid_conflict_choice'); if (o.mappings)
        assert(Object.values(object(o.mappings)).every(v => typeof v === 'string' && /^[0-9]{6,22}$/.test(v)), 'invalid_mapping'); for (const k of ['policy', 'restoreDeleted'] as const)
        assert(o[k] === undefined || typeof o[k] === 'boolean', 'invalid_option'); }
    async apply(guild: string, actor: string, input: unknown, options: ImportOptions, token: string) {
        await this.authority(guild, actor);
        this.options(options);
        const { pack, images } = await validatePack(input);
        await this.mapping(guild, actor, pack, options);
        const prepared = structuredClone(pack);
        for (const c of prepared.components)
            if (c.kind === 'images')
                c.value.normalizedDigest = images.get(c.value.asset)!.sha256;
        try {
            return await this.services.store.withGuild(guild, async (tx) => {
                const plan = await this.plan(tx, guild, prepared, options), expires = Number(token?.split('.')[0]);
                assert(expires > Date.now() && expires <= Date.now() + 10 * 60000 && token === expires + '.' + mac(this.services, { guild, actor, digest: packHash(pack), options, snapshot: packHash(plan.snap), expires }), 'pack_preview_stale_retry', 409);
                const ids = new Map(plan.result.map(r => [r.c.id, r.existing?.id ?? randomUUID()]));
                for (const r of plan.result)
                    if (r.choice !== 'keep')
                        for (const dep of r.c.dependencies) {
                            const d = plan.result.find(d => d.c.id === dep)!;
                            assert(d.existing || d.choice !== 'keep', 'dependency_was_deleted');
                        }
                let added = 0, replaced = 0, kept = 0;
                const receipt: Receipt = structuredClone(plan.receipt) ?? { ...baseRecord(guild, randomUUID()), pack: pack.id, versions: [], components: {} };
                receipt.baselines ??= {};
                for (const kind of kinds)
                    for (const r of plan.result.filter(r => r.c.kind === kind)) {
                        if (r.choice === 'keep') {
                            kept++;
                            if (r.existing) {
                                receipt.components[r.c.id] = r.existing.id;
                                receipt.baselines[r.existing.id] ??= packHash(policyValue(r.existing));
                            }
                            continue;
                        }
                        const c = r.c, old = r.existing;
                        let value: any = { ...c.value, name: c.name };
                        delete value.normalizedDigest;
                        if (kind === 'images') {
                            const image = images.get(c.value.asset)!;
                            value = { name: c.name, enabled: c.value.enabled, groupId: c.value.groupId ? ids.get(c.value.groupId) : null, objectKey: await this.services.objects.put(guild, image), sha256: image.sha256, hashVersion: image.hashVersion, bytes: image.bytes.length, width: image.width, height: image.height, createdBy: actor };
                        }
                        if (kind === 'rules')
                            value = { ...parseRule({ ...c.value, name: c.name, groupId: c.value.groupId ? ids.get(c.value.groupId) : null, referenceId: c.value.referenceId ? ids.get(c.value.referenceId) : null, automatic: false, enabled: false }), approval: null };
                        const row = { ...baseRecord(guild, ids.get(c.id)!), createdAt: old?.createdAt ?? new Date().toISOString(), ...value, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
                        row.packOrigin = { pack: pack.id, component: c.id, digest: packHash(pack.components.find(p => p.id === c.id)), baseline: packHash(policyValue(row)) };
                        await tx.put(kind, row, old?.revision ?? 0);
                        receipt.components[c.id] = row.id;
                        receipt.baselines[row.id] = packHash(policyValue(row));
                        old ? replaced++ : added++;
                    }
                for (const kind of kinds)
                    assert((await tx.all(kind, guild)).length <= (kind === 'groups' ? 100 : 250), 'destination_component_limit');
                if (options.policy && pack.policy) {
                    const s: any = { ...pack.policy.settings };
                    const map = options.mappings ?? {};
                    for (const k of ['channels', 'excludedChannels', 'exemptRoles'])
                        s[k] = s[k].map((id: string) => map[id]);
                    s.logChannel = s.logChannel ? map[s.logChannel] : null;
                    s.enforcement = false;
                    s.highImpactEnabled = false;
                    s.textStartersInstalled = plan.snap.settings.value.textStartersInstalled;
                    s.onboardingStarters = plan.snap.settings.value.onboardingStarters;
                    await tx.putSettings(guild, parseSettings(s, plan.snap.settings.value), plan.snap.settings.revision);
                    for (const g of pack.policy.grants) {
                        const existing = (plan.snap.records.grants as RoleGrant[]).find(r => r.roleId === map[g.role]);
                        assert(!existing || canonical(existing.capabilities) === canonical(g.capabilities), 'grant_conflict_keep_destination');
                        if (!existing)
                            await tx.put('grants', { ...baseRecord(guild, randomUUID()), roleId: map[g.role], capabilities: g.capabilities }, 0);
                    }
                }
                else { // Advance the seed tombstone, even for a prompt-only import.
                    await tx.putSettings(guild, plan.snap.settings.value, plan.snap.settings.revision);
                }
                receipt.versions = [...new Set([...receipt.versions, pack.version])].slice(-100);
                receipt.revision = (plan.receipt?.revision ?? 0) + 1;
                receipt.evidence = pack.evidence;
                receipt.importedDigest = packDigest(pack);
                receipt.provenance = pack.provenance;
                receipt.sourceChanged = pack.compatibility.normalization !== NORMALIZATION_HASH_VERSION || pack.compatibility.model !== (await tx.getSettings(guild)).value.model || plan.result.some(r => r.choice === 'keep' && r.status !== 'already imported' || r.c.kind === 'rules' && (r.c.value.enabled || r.c.value.automatic));
                if (options.policy)
                    receipt.policyBaseline = packHash((await tx.getSettings(guild)).value);
                await tx.put('packs', receipt, plan.receipt?.revision ?? 0);
                const result = { added, replaced, kept, digest: packDigest(pack), version: pack.version };
                await this.services.audit(guild, actor, 'pack.imported', pack.id, { ...result, evidence: pack.evidence, provenance: pack.provenance, compatibility: pack.compatibility, approval: 'destination_required', policy: !!options.policy }, tx);
                return result;
            });
        }
        catch (e) { // GC retains young objects: another upload can be about to reference them.
            await this.services.objects.collect(guild, new Set((await this.services.store.all<ReferenceImage>('images', guild)).map(i => i.objectKey))).catch(() => { });
            throw e;
        }
    }
}
