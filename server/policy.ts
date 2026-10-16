import { createHash } from 'node:crypto';
import { isPunitive, isSevere, type Rule, type ReferenceImage, type Match, type Settings, type Action } from '../shared/domain.js';
export const PROMPT_VERSION = 'image-identity-v1';
const rank = { individual: 0, group: 1, any_match: 2, any_image: 3 };
export function referencesFor(rule: Rule, images: ReferenceImage[]): ReferenceImage[] {
    return images.filter(i => i.guildId === rule.guildId && i.enabled && (rule.type === 'individual' ? i.id === rule.referenceId : rule.type === 'group' ? i.groupId === rule.groupId : rule.type === 'any_match'));
}
export function fingerprint(rule: Rule, images: ReferenceImage[], settings: Settings): string {
    const { approval, revision, createdAt, updatedAt, ...policy } = rule;
    return createHash('sha256').update(JSON.stringify({ policy, model: settings.model, prompt: PROMPT_VERSION, thresholds: settings.thresholds,
        refs: referencesFor(rule, images).map(i => [i.id, i.sha256, i.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) })).digest('hex');
}
export interface Decision {
    rule: Rule;
    match: Match;
    action: Action;
    deleteMessage: boolean;
    execute: boolean;
    reason: string;
}
export function resolvePolicy(rules: Rule[], matches: Match[], settings: Settings, images: ReferenceImage[]): Decision | null {
    const eligible = rules.filter(r => r.enabled && (r.type !== 'any_image' || settings.anyImageEnabled) && (r.mode !== 'semantic' || settings.semanticEnabled));
    const matched = eligible.flatMap(rule => {
        const floor = Math.max(rule.threshold, settings.thresholds[rule.action]);
        const candidates = matches.filter(m => m.ruleId === rule.id && Number.isFinite(m.probability) && m.probability >= floor && m.probability <= 1 && m.model === settings.model)
            .sort((a, b) => b.probability - a.probability || a.attachmentId.localeCompare(b.attachmentId));
        return candidates[0] ? [{ rule, match: candidates[0] }] : [];
    }).sort((a, b) => b.rule.priority - a.rule.priority || rank[a.rule.type] - rank[b.rule.type] || a.rule.id.localeCompare(b.rule.id));
    const selected = matched[0];
    if (!selected) {
        if (settings.uncertain === 'ignore')
            return null;
        const uncertain = matches.find(m => m.probability >= 0.5 && m.probability <= 1 && eligible.some(r => r.id === m.ruleId));
        const r = uncertain && eligible.find(r => r.id === uncertain.ruleId);
        return r && uncertain ? { rule: r, match: uncertain, action: 'review', deleteMessage: false, execute: false, reason: 'uncertain' } : null;
    }
    const { rule, match } = selected;
    let reason = 'eligible';
    if (!settings.enforcement)
        reason = 'monitoring_only';
    else if (!rule.automatic)
        reason = 'rule_not_automatic';
    else if (!isPunitive(rule.action))
        reason = 'nonpunitive';
    else if (rule.mode === 'semantic')
        reason = 'semantic_review_only';
    else if (isSevere(rule.action) && !settings.highImpactEnabled)
        reason = 'high_impact_disabled';
    else if ((rule.secondVerification || isSevere(rule.action)) && !match.verified && rule.type !== 'any_image')
        reason = 'verification_required';
    else if (rule.approval?.fingerprint !== fingerprint(rule, images, settings))
        reason = 'calibration_approval_required';
    return { rule, match, action: rule.action, deleteMessage: rule.deleteMessage || rule.action === 'delete', execute: reason === 'eligible', reason };
}
