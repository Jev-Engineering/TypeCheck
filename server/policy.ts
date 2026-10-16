import { createHash } from 'node:crypto';
import { isPunitive, isSevere, type Rule, type ReferenceImage, type Match, type Settings, type Action } from '../shared/domain.js';
import { effectiveThreshold } from '../shared/domain.js';
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
    // Use the same validity checks and precedence for action and review candidates.
    const candidates = eligible.flatMap(rule => {
        const floor = effectiveThreshold(rule, settings);
        const valid = matches.filter(m => m.ruleId === rule.id && Number.isFinite(m.probability) && m.probability >= 0 && m.probability <= 1 && m.model === settings.model)
            .sort((a, b) => b.probability - a.probability || a.attachmentId.localeCompare(b.attachmentId)
                || (a.referenceId ?? '').localeCompare(b.referenceId ?? '') || Number(a.verified) - Number(b.verified));
        return valid[0] ? [{ rule, match: valid[0], floor }] : [];
    }).sort((a, b) => b.rule.priority - a.rule.priority || rank[a.rule.type] - rank[b.rule.type] || a.rule.id.localeCompare(b.rule.id));
    const selected = candidates.find(c => c.match.probability >= c.floor);
    if (!selected) {
        if (settings.uncertain === 'ignore')
            return null;
        // If review >= floor this half-open band is empty; action selection still wins.
        const uncertain = candidates.find(c => c.match.probability >= settings.thresholds.review && c.match.probability < c.floor);
        return uncertain ? { rule: uncertain.rule, match: uncertain.match, action: 'review', deleteMessage: false, execute: false, reason: 'uncertain' } : null;
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
