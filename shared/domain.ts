import { parseText, type TextDefinition, type TextEvidence } from './text.js';
import { parseContent, type ContentDefinition, type ContentEvidence } from './content.js';
export const CAPABILITIES = [
    'dashboard.view', 'images.view', 'images.add', 'images.edit', 'images.delete',
    'rules.view', 'rules.create', 'rules.edit', 'rules.delete', 'actions.change', 'timeouts.configure',
    'kick.enable', 'ban.enable', 'matching.test', 'logs.view', 'logs.export', 'enforcement.pause',
    'moderators.delegate', 'channels.configure', 'credentials.manage', 'security.manage', 'permissions.manage'
] as const;
export type Capability = typeof CAPABILITIES[number];
export const ADMIN_ONLY: readonly Capability[] = ['credentials.manage', 'security.manage', 'permissions.manage'];
export type Mode = 'exact' | 'transformed' | 'partial' | 'semantic';
export type Action = 'none' | 'delete' | 'warn' | 'timeout' | 'kick' | 'ban' | 'review';
export type RuleType = 'individual' | 'group' | 'any_match' | 'any_image' | 'content' | 'text';
export interface Settings {
    typesafeReviewConsent?: boolean;
    completeTechTrainingConsent?: boolean;
    textModerationEnabled?: boolean;
    textStartersInstalled?: boolean;
    contentMessageContext?: boolean;
    monitoring: boolean;
    enforcement: boolean;
    anyImageEnabled: boolean;
    semanticEnabled: boolean;
    channels: string[];
    excludedChannels: string[];
    exemptRoles: string[];
    processBots: boolean;
    processWebhooks: boolean;
    logChannel: string | null;
    dmNotify: boolean;
    thresholds: Record<Action, number>;
    dailyCallLimit: number;
    logRetentionDays: number;
    uncertain: 'review' | 'ignore';
    highImpactEnabled: boolean;
    model: string;
}
// Practical starting points; scores depend on the domain, model and images.
export const MATCH_THRESHOLDS = { standard: 0.70, strict: 0.90, min: 0.5, max: 1.0 } as const;
export const DEFAULT_RULE_THRESHOLD = MATCH_THRESHOLDS.standard;
export const DATA_USE_NOTICE_VERSION = '2026-10-17.1';
export const DEFAULT_SETTINGS: Settings = {
    typesafeReviewConsent: false, completeTechTrainingConsent: false,
    textModerationEnabled: false, textStartersInstalled: false, contentMessageContext: false, monitoring: true, enforcement: false, anyImageEnabled: false, semanticEnabled: false,
    channels: [], excludedChannels: [], exemptRoles: [], processBots: false, processWebhooks: false,
    logChannel: null, dmNotify: false,
    thresholds: { none: MATCH_THRESHOLDS.standard, delete: MATCH_THRESHOLDS.standard, warn: MATCH_THRESHOLDS.standard, timeout: MATCH_THRESHOLDS.strict, kick: MATCH_THRESHOLDS.strict, ban: MATCH_THRESHOLDS.strict, review: MATCH_THRESHOLDS.standard },
    dailyCallLimit: 500, logRetentionDays: 30, uncertain: 'review', highImpactEnabled: false, model: 'jev-1.14.0'
};
export interface RecordBase {
    id: string;
    guildId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
}
export interface Group extends RecordBase {
    name: string;
}
export interface ReferenceImage extends RecordBase {
    name: string;
    groupId: string | null;
    enabled: boolean;
    objectKey: string;
    sha256: string;
    hashVersion?: string;
    bytes: number;
    width: number;
    height: number;
    createdBy: string;
}
export interface Approval {
    fingerprint: string;
    actor: string;
    at: string;
    note: string;
}
export interface Rule extends RecordBase {
    text?: TextDefinition;
    content?: ContentDefinition;
    name: string;
    type: RuleType;
    referenceId: string | null;
    groupId: string | null;
    mode: Mode;
    threshold: number;
    action: Action;
    timeoutSeconds: number;
    deleteMessage: boolean;
    priority: number;
    enabled: boolean;
    automatic: boolean;
    secondVerification: boolean;
    reason: string;
    approval: Approval | null;
}
export interface RoleGrant extends RecordBase {
    roleId: string;
    capabilities: Capability[];
}
export interface CipherEnvelope {
    version: 1;
    iv: string;
    tag: string;
    ciphertext: string;
}
export interface Credential extends RecordBase {
    encrypted: CipherEnvelope;
    status: 'valid' | 'error';
    validatedAt: string;
    lastError: string | null;
}
export interface Calibration extends RecordBase {
    text?: TextEvidence;
    content?: ContentEvidence;
    ruleId: string;
    fingerprint: string;
    model: string | null;
    expected: boolean;
    predicted: boolean;
    probability: number | null;
    provenance?: 'exact_hash' | 'jev';
    sampleSha256: string;
    actor: string;
}
export interface Match {
    text?: TextEvidence;
    content?: ContentEvidence;
    ruleId: string;
    referenceId: string | null;
    provenance?: 'exact_hash' | 'jev' | 'any_image' | 'content' | 'text';
    probability: number | null;
    verified: boolean;
    model: string | null;
    referenceRevision?: number;
    policyFingerprint?: string;
    hashVersion?: string;
    attachmentId: string;
}
export interface Evaluation extends RecordBase {
    policySnapshot?: string;
    messageId: string;
    channelId: string;
    userId: string;
    attachmentId: string;
    matches: Match[];
    outcome: string;
    error: string | null;
    inputTokens: number;
    model: string | null;
    hashComparisons?: number;
    test: boolean;
}
export interface Audit extends RecordBase {
    actor: string;
    event: string;
    target: string;
    detail: Record<string, unknown>;
}
export interface ModerationEvent extends RecordBase {
    messageId: string;
    channelId: string;
    userId: string;
    ruleId: string | null;
    intended: Action;
    actual: string;
    reason: string;
    matches: Match[];
    reviewStatus: 'open' | 'confirmed' | 'false_positive' | 'dismissed' | null;
}
export interface Attachment {
    id: string;
    url: string;
    size: number;
    contentType: string | null;
    filename: string;
}
export interface ImageMessage {
    editedAt?: string | null;
    textDigest?: string;
    content?: string;
    guildId: string;
    channelId: string;
    messageId: string;
    userId: string;
    bot: boolean;
    webhook: boolean;
    attachments: Attachment[];
}
export interface Job {
    id: string;
    guildId: string;
    message: ImageMessage;
    signature: string;
    status: 'queued' | 'processing' | 'done' | 'failed';
    error: string | null;
    createdAt: string;
}
export type Kind = 'groups' | 'images' | 'rules' | 'grants' | 'credentials' | 'calibrations' | 'evaluations' | 'events' | 'audit';
export interface Session {
    userId: string;
    guildId: string;
    expiresAt: number;
}
export interface MemberInfo {
    userId: string;
    guildId: string;
    owner: boolean;
    administrator: boolean;
    roles: string[];
}
export interface Authority extends MemberInfo {
    capabilities: Capability[];
}
export const ACTIONS: Action[] = ['none', 'delete', 'warn', 'timeout', 'kick', 'ban', 'review'];
export const MODES: Mode[] = ['exact', 'transformed', 'partial', 'semantic'];
export const RULE_TYPES: RuleType[] = ['individual', 'group', 'any_match', 'any_image', 'content', 'text'];
export const isPunitive = (a: Action): boolean => !['none', 'review'].includes(a);
export const isSevere = (a: Action): boolean => a === 'kick' || a === 'ban';
export const snowflake = (s: unknown): s is string => typeof s === 'string' && /^[0-9]{6,22}$/.test(s);
export const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export class AppError extends Error {
    constructor(public code: string, public status = 400) { super(code); this.name = 'AppError'; }
}
export function assert(condition: unknown, code: string, status = 400): asserts condition { if (!condition)
    throw new AppError(code, status); }
export function baseRecord(guildId: string, id: string): RecordBase {
    const now = new Date().toISOString();
    return { id, guildId, revision: 1, createdAt: now, updatedAt: now };
}
export function object(value: unknown): Record<string, unknown> {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'object_required');
    return value as Record<string, unknown>;
}
export function onlyKeys(v: Record<string, unknown>, keys: readonly string[]) {
    assert(Object.keys(v).every(k => keys.includes(k)), 'unknown_field');
}
export function text(v: unknown, max = 160): string { assert(typeof v === 'string' && v.trim().length > 0 && v.length <= max, 'invalid_text'); return v.trim(); }
export function bool(v: unknown): boolean { assert(typeof v === 'boolean', 'invalid_boolean'); return v; }
export function number(v: unknown, min: number, max: number, integer = false): number {
    assert(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)), 'invalid_number');
    return v;
}
export function ids(v: unknown): string[] { assert(Array.isArray(v) && v.length <= 250 && v.every(snowflake), 'invalid_ids'); return [...new Set(v)]; }
export function matchThreshold(value: unknown): number {
    assert(typeof value === 'number' && Number.isFinite(value) && value >= MATCH_THRESHOLDS.min && value <= MATCH_THRESHOLDS.max, 'match_threshold_must_be_a_finite_number_from_0.5_to_1.0');
    return value;
}
export function effectiveThreshold(rule: Pick<Rule, 'threshold' | 'action'>, settings: Settings): number {
    return Math.max(rule.threshold, settings.thresholds[rule.action]);
}
// Fill only absent fields; never reinterpret a saved threshold as a preset.
export function storedRecord<T extends RecordBase>(kind: Kind, record: T): T {
    return kind === 'rules' && !Object.hasOwn(record, 'threshold') ? { ...record, threshold: DEFAULT_RULE_THRESHOLD } : record;
}
export function parseSettings(value: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
    const v = object(value);
    onlyKeys(v, Object.keys(DEFAULT_SETTINGS));
    const s = structuredClone(defaults);
    for (const k of ['typesafeReviewConsent', 'completeTechTrainingConsent', 'textModerationEnabled', 'textStartersInstalled', 'contentMessageContext', 'monitoring', 'enforcement', 'anyImageEnabled', 'semanticEnabled', 'processBots', 'processWebhooks', 'dmNotify', 'highImpactEnabled'] as const)
        if (k in v)
            s[k] = bool(v[k]);
    for (const k of ['channels', 'excludedChannels', 'exemptRoles'] as const)
        if (k in v)
            s[k] = ids(v[k]);
    if ('logChannel' in v) {
        assert(v.logChannel === null || snowflake(v.logChannel), 'invalid_channel');
        s.logChannel = v.logChannel;
    }
    if ('thresholds' in v) {
        const t = object(v.thresholds);
        onlyKeys(t, ACTIONS);
        for (const a of ACTIONS)
            if (a in t)
                s.thresholds[a] = matchThreshold(t[a]);
    }
    assert(s.thresholds.kick >= s.thresholds.timeout && s.thresholds.ban >= s.thresholds.kick, 'severe_threshold_must_not_be_lower');
    if ('dailyCallLimit' in v)
        s.dailyCallLimit = number(v.dailyCallLimit, 1, 100000, true);
    if ('logRetentionDays' in v)
        s.logRetentionDays = number(v.logRetentionDays, 1, 365, true);
    if ('uncertain' in v) {
        assert(v.uncertain === 'review' || v.uncertain === 'ignore', 'invalid_uncertainty_policy');
        s.uncertain = v.uncertain;
    }
    if ('model' in v) {
        s.model = text(v.model, 60);
        assert(/^jev-\d+\.\d+\.\d+$/.test(s.model), 'pin_versioned_jev_model');
    }
    return s;
}
// SQL JSON objects may have database-defined key order. Preserve existing floor
// ordering because historical approval fingerprints hash its JSON representation.
export function storedSettings(value: unknown): Settings {
    const v = object(value), parsed = parseSettings(v);
    const thresholds = Object.hasOwn(v, 'thresholds') ? { ...object(v.thresholds) } : {};
    for (const action of ACTIONS)
        if (!Object.hasOwn(thresholds, action)) thresholds[action] = parsed.thresholds[action];
    return { ...parsed, thresholds: thresholds as Record<Action, number> };
}
export type RuleInput = Omit<Rule, keyof RecordBase | 'approval'>;
export function parseRule(value: unknown, defaultThreshold: number = DEFAULT_RULE_THRESHOLD): RuleInput {
    const v = object(value);
    onlyKeys(v, ['name', 'type', 'referenceId', 'groupId', 'mode', 'threshold', 'action', 'timeoutSeconds', 'deleteMessage', 'priority', 'enabled', 'automatic', 'secondVerification', 'reason', 'content', 'text']);
    assert(RULE_TYPES.includes(v.type as RuleType), 'invalid_rule_type');
    assert(MODES.includes(v.mode as Mode), 'invalid_matching_mode');
    assert(ACTIONS.includes(v.action as Action), 'invalid_action');
    assert(v.referenceId === null || uuid(v.referenceId), 'invalid_reference');
    assert(v.groupId === null || uuid(v.groupId), 'invalid_group');
    const type = v.type as RuleType;
    assert((type === 'individual') === (v.referenceId !== null), 'individual_reference_required');
    assert((type === 'group') === (v.groupId !== null), 'group_reference_required');
    const r: RuleInput = { name: text(v.name), type, referenceId: v.referenceId, groupId: v.groupId, mode: v.mode as Mode,
        threshold: matchThreshold(Object.hasOwn(v, 'threshold') ? v.threshold : defaultThreshold), action: v.action as Action, timeoutSeconds: number(v.timeoutSeconds, 1, 2419200, true),
        deleteMessage: bool(v.deleteMessage), priority: number(v.priority, -1000, 1000, true), enabled: bool(v.enabled), automatic: bool(v.automatic),
        secondVerification: bool(v.secondVerification), reason: text(v.reason, 300) };
    if (type === 'content') { r.content = parseContent(v.content); assert(r.mode === 'exact', 'content_has_no_similarity_mode'); }
    else assert(v.content === undefined, 'content_definition_requires_content_rule');
    if (type === 'text') { r.text = parseText(v.text); assert(r.mode === 'exact', 'text_has_no_similarity_mode'); assert(!r.enabled || r.text.configured, 'text_policy_configuration_required'); }
    else assert(v.text === undefined, 'text_definition_requires_text_rule');
    if (isSevere(r.action))
        r.secondVerification = true;
    assert(r.type !== 'any_image' || r.mode === 'exact', 'any_image_mode_not_similarity');
    assert(!(['none', 'review'].includes(r.action) && r.deleteMessage), 'nonpunitive_rule_cannot_delete');
    return r;
}
export function effectiveAuthority(member: MemberInfo, grants: RoleGrant[]): Authority {
    const admin = member.owner || member.administrator;
    const roles = new Set([...member.roles, member.guildId]);
    return { ...member, capabilities: admin ? [...CAPABILITIES] : [...new Set(grants.filter(g => g.guildId === member.guildId && roles.has(g.roleId)).flatMap(g => g.capabilities).filter(c => !ADMIN_ONLY.includes(c)))] };
}
export function requireCapability(a: Authority, c: Capability) { assert(a.capabilities.includes(c), 'forbidden', 403); }


export function timeoutPreset(seconds: number): string {
    return [60, 300, 600, 3600, 86400, 604800, 2419200].includes(seconds) ? String(seconds) : 'custom';
}
