import { createHash, randomUUID } from 'node:crypto';
import { assert, baseRecord, ids, object, onlyKeys, parseRule, parseSettings, snowflake, text, uuid, type Audit, type Rule, type Group, type ReferenceImage, type Settings } from '../shared/domain.js';
import { TEXT_STARTERS } from '../shared/text-starters.js';
import { ONBOARDING_PRESETS, ONBOARDING_NOTICE, type SetupSelection } from '../shared/onboarding.js';
import type { Services } from './services.js';
import type { Store } from './store.js';
import { scamReferenceComponent } from './pack-starters.js';
import { packHash } from './packs.js';
type PackReceipt = import('../shared/domain.js').RecordBase & {pack: string; components: Record<string,string>};

// Canonical hashing also works with MySQL JSON key reordering.
export function canonical(value: any): string {
    return JSON.stringify(value === undefined ? null : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, JSON.parse(canonical(value[k]))])) : value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const isAdmin = async (s: Services, guild: string, actor: string) => { const a = await s.authority(guild, actor); assert(a.owner || a.administrator, 'administrator_required', 403); return a; };
export function selection(value: unknown): SetupSelection {
    const v = object(value); onlyKeys(v, ['presets', 'channels', 'excludedChannels', 'exemptRoles', 'logChannel', 'customizations']);
    assert(Array.isArray(v.presets) && v.presets.length > 0 && v.presets.length <= 4, 'invalid_presets');
    const presets = [...new Set(v.presets.map(p => text(p, 40)))];
    assert(presets.every(p => ONBOARDING_PRESETS.some(s => s.id === p)), 'unknown_preset');
    assert(v.logChannel === null || snowflake(v.logChannel), 'invalid_log_channel');
    const customizations: SetupSelection['customizations'] = {};
    for (const [id, raw] of Object.entries(object(v.customizations ?? {}))) {
        assert(TEXT_STARTERS.some(s => s.id === id), 'unknown_component');
        const c = object(raw); onlyKeys(c, ['name', 'question', 'positive', 'negative', 'exceptions']);
        customizations[id] = Object.fromEntries(Object.entries(c).map(([k, val]) => [k, text(val, k === 'name' ? 160 : 1200)]));
    }
    return { presets, channels: ids(v.channels), excludedChannels: ids(v.excludedChannels), exemptRoles: ids(v.exemptRoles), logChannel: v.logChannel, customizations };
}
export function installedComponents(settings: Settings, rules: Rule[], packs: PackReceipt[] = []): Set<string> {
    return new Set([...(settings.onboardingStarters ?? []), ...rules.filter(r => r.type === 'text').map(r => r.text?.preset ?? ''), ...(settings.textStartersInstalled ? TEXT_STARTERS.map(s => s.id) : []), ...(packs.some(p=>p.pack==='combined-scam-setup'&&Object.hasOwn(p.components,'reference-rule'))?['image_scams']:[])]);
}
async function snapshot(tx: Store, guild: string) {
    const settings = await tx.getSettings(guild);
    const rules = (await tx.all<Rule>('rules', guild)).sort((a,b) => a.id.localeCompare(b.id));
    const groups = (await tx.all<Group>('groups', guild)).sort((a,b) => a.id.localeCompare(b.id));
    const images = (await tx.all<ReferenceImage>('images', guild)).map(({id, revision, groupId, enabled, createdBy}) => ({id, revision, groupId, enabled, createdBy})).sort((a,b) => a.id.localeCompare(b.id));
    const grants = (await tx.all('grants', guild)).sort((a,b) => a.id.localeCompare(b.id));
    const packs = (await tx.all<PackReceipt>('packs', guild)).sort((a,b)=>a.id.localeCompare(b.id));
    const definitions = (await tx.all('definitions', guild)).sort((a,b)=>a.id.localeCompare(b.id));
    return { settings, rules, groups, images, packs, revision: hash({ settings, rules, groups, images, grants, packs, definitions }) };
}
export class Onboarding {
    constructor(readonly services: Services) {}
    async context(guild: string, actor: string) {
        const authority = await isAdmin(this.services, guild, actor);
        const credential = await this.services.credentialStatus(guild);
        const s = await this.services.store.getSettings(guild);
        return { guildId: guild, userId: actor, administrator: authority.administrator, owner: authority.owner, botOnline: this.services.discord.online, credential: { configured: credential.configured, status: credential.status }, enforcement: s.value.enforcement, blockers: [!this.services.discord.online && 'bot_offline', !credential.configured && 'credential_missing_use_settings', !s.value.channels.length && 'no_monitored_channels', !s.value.logChannel && 'no_log_destination'].filter(Boolean), remaining: ['Check bot channel permissions in Discord', 'Configure and test disabled rules', 'Calibrate and approve separately', 'Deployment acceptance remains separate'], notice: ONBOARDING_NOTICE };
    }
    async inventory(guild: string, actor: string, offset = 0) {
        await isAdmin(this.services, guild, actor);
        assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000, 'invalid_offset');
        const meta = await this.services.discord.metadata(guild), s = await snapshot(this.services.store, guild);
        const page = <T>(items: T[]) => ({ items: items.slice(offset, offset + 50), nextOffset: items.length > offset + 50 ? offset + 50 : null, total: items.length });
        return { untrustedData: true, name: meta.name, channels: page(meta.channels.map(({id,name,type}) => ({id,name,type}))), roles: page(meta.roles.map(({id,name}) => ({id,name}))), settings: s.settings, rules: page(s.rules), groups: page(s.groups), referenceCount: s.images.length };
    }
    async plan(guild: string, actor: string, binding: string, raw: unknown) {
        await isAdmin(this.services, guild, actor);
        const chosen = selection(raw), meta = await this.services.discord.metadata(guild);
        const validChannels = new Set(meta.channels.filter(c => c.type === 0 || c.type === 5).map(c => c.id));
        assert([...chosen.channels, ...chosen.excludedChannels, ...(chosen.logChannel ? [chosen.logChannel] : [])].every(c => validChannels.has(c)), 'channel_not_available');
        assert(chosen.exemptRoles.every(r => meta.roles.some(v => v.id === r)), 'role_not_available');
        assert(!chosen.channels.some(c => chosen.excludedChannels.includes(c)), 'channel_selected_and_excluded');
        return this.services.store.withGuild(guild, async tx => {
            const s = await snapshot(tx, guild), installed = installedComponents(s.settings.value, s.rules, s.packs);
            const components: string[] = [...new Set(chosen.presets.flatMap(id => [...ONBOARDING_PRESETS.find(p => p.id === id)!.components]))].sort();
            assert(Object.keys(chosen.customizations).every(k => components.includes(k)), 'customization_outside_selection');
            const additions: Rule[] = [], skipped: string[] = [];
            for (const id of components) {
                if (installed.has(id)) { skipped.push(id); continue; }
                const starter = TEXT_STARTERS.find(v => v.id === id), custom = chosen.customizations[id] ?? {};
                let groupId: string | null = null;
                if (!starter) {
                    const groups = new Set([...s.packs.filter(p=>['reviewed-scam-references','combined-scam-setup'].includes(p.pack)).map(p=>p.components['scam-references']).filter(Boolean), ...s.images.filter(i => i.createdBy === 'system-starter-references' && i.enabled && i.groupId).map(i => i.groupId)]);
                    assert(groups.size === 1, 'starter_reference_group_missing_use_image_library', 409);
                    groupId = [...groups][0]!;
                    assert(s.groups.some(g => g.id === groupId) && s.images.some(i=>i.groupId===groupId&&i.enabled), 'starter_reference_group_missing', 409);
                }
                const {name, ...definition} = custom;
                const component=scamReferenceComponent();
                const input = parseRule(starter ? { name: name ?? starter.name, type:'text', text: {...starter.definition, ...definition}, referenceId: null, groupId:null, mode:'exact', threshold:.9, action:'review', timeoutSeconds:600, deleteMessage:false, priority:0, enabled:false, automatic:false, secondVerification:true, reason:'Administrator-reviewed onboarding policy' } : {...component.value, name:component.name,groupId});
                additions.push({ ...baseRecord(guild, randomUUID()), ...input, approval: null, ...(!starter ? {packOrigin:{pack:'combined-scam-setup',component:component.id,digest:packHash(component),baseline:packHash({...input,approval:null})}} : {}) });
            }
            assert(s.rules.length + additions.length <= 250, 'rule_limit');
            // Union preserves existing configuration; excluded channels remain authoritative.
            const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
            const after: Settings = parseSettings({ ...s.settings.value, channels: union(s.settings.value.channels, chosen.channels), excludedChannels: union(s.settings.value.excludedChannels, chosen.excludedChannels), exemptRoles: union(s.settings.value.exemptRoles, chosen.exemptRoles), logChannel: chosen.logChannel ?? s.settings.value.logChannel, enforcement: false, onboardingStarters: union([...installed].filter(Boolean), components) });
            const id = randomUUID(), plan = { id, guildId: guild, actor, binding: hash([binding, id]), expiresAt: Date.now() + 10 * 60000, revision: s.revision, before: s.settings, existingRules: s.rules, after, additions, skipped, warnings: [ONBOARDING_NOTICE, 'Existing exclusions win over selected channels. Existing rules and approvals are preserved; changed settings may make their approval fingerprints stale. Rules remain disabled. Manual Settings handles removals and activation.'] };
            const digest = hash(plan), record: Audit = { ...baseRecord(guild, id), actor, event: 'onboarding.plan', target: id, detail: { plan, digest, status: 'proposed' } };
            await tx.put('audit', record, 0);
            return this.view(record);
        });
    }
    private view(r: Audit) { const { binding, revision, ...plan } = r.detail.plan as any; return { ...plan, digest: r.detail.digest, status: r.detail.status, receipt: r.detail.receipt ?? null }; }
    async transition(guild: string, actor: string, binding: string, raw: unknown, action: 'inspect' | 'accept' | 'apply') {
        await isAdmin(this.services, guild, actor);
        const b = object(raw); onlyKeys(b, ['planId', 'digest']); assert(uuid(b.planId) && typeof b.digest === 'string' && /^[a-f0-9]{64}$/.test(b.digest), 'invalid_plan');
        const meta = action === 'apply' ? await this.services.discord.metadata(guild) : null;
        return this.services.store.withGuild(guild, async tx => {
            const r = await tx.get<Audit>('audit', guild, b.planId as string);
            assert(r?.event === 'onboarding.plan', 'plan_not_found', 404);
            const p = r.detail.plan as any;
            assert(r.actor === actor && p.guildId === guild && p.binding === hash([binding, r.id]) && r.detail.digest === b.digest && hash(p) === b.digest, 'plan_binding_mismatch', 403);
            if (r.detail.status === 'applied') return this.view(r); // receipt recovery after response loss, even after expiry
            assert(p.expiresAt > Date.now(), 'plan_expired', 409);
            assert((await snapshot(tx, guild)).revision === p.revision, 'plan_stale', 409);
            if (action === 'inspect') return this.view(r);
            if (action === 'accept') r.detail.status = 'accepted';
            else {
                assert(r.detail.status === 'accepted', 'explicit_acceptance_required', 409);
                assert([...p.after.channels, ...p.after.excludedChannels, ...(p.after.logChannel ? [p.after.logChannel] : [])].every((id: string) => meta!.channels.some(c => c.id === id && [0,5].includes(c.type))) && p.after.exemptRoles.every((id: string) => meta!.roles.some(v => v.id === id)), 'discord_inventory_changed', 409);
                for (const rule of p.additions as Rule[]) await tx.put('rules', rule, 0);
                await tx.putSettings(guild, p.after, p.before.revision);
                r.detail.status = 'applied';
                r.detail.receipt = { planId: r.id, digest: b.digest, actor, guildId: guild, at: new Date().toISOString(), ruleIds: (p.additions as Rule[]).map(v => v.id), settingsRevision: p.before.revision + 1, enforcement: false, recovery: 'Atomic commit; retry this exact plan for the same receipt. No provider or Discord writes occur.' };
            }
            await tx.put('audit', { ...r, revision: r.revision + 1, updatedAt: new Date().toISOString() }, r.revision);
            await this.services.audit(guild, actor, 'onboarding.' + action, r.id, { digest: b.digest }, tx);
            return this.view(r);
        });
    }
}
