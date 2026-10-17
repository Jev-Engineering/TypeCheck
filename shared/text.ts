import { assert, object, onlyKeys, text } from './domain.js';
export const TEXT_VERSION = 'message-text-v1';
export const TEXT_MODELS = ['jev-1.13.0', 'jev-1.14.0'];
export const TEXT_LIMITS = { characters: 4000, bytes: 16000, rules: 8, requestBytes: 48000 } as const;
export interface TextDefinition {
    version: typeof TEXT_VERSION;
    preset: string;
    presetVersion: 1;
    question: string;
    positive: string;
    negative: string;
    exceptions: string;
    contextRequirements: string;
    requirePromotion: boolean;
    configured: boolean;
}
export function parseText(value: unknown): TextDefinition {
    const v = object(value);
    onlyKeys(v, ['version', 'preset', 'presetVersion', 'question', 'positive', 'negative', 'exceptions', 'contextRequirements', 'requirePromotion', 'configured']);
    assert(v.version === TEXT_VERSION && v.presetVersion === 1, 'unsupported_text_version');
    assert(typeof v.preset === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v.preset), 'invalid_text_preset');
    assert(typeof v.requirePromotion === 'boolean' && typeof v.configured === 'boolean', 'invalid_text_boolean');
    assert(!v.configured || !String(v.positive).includes('REPLACE'), 'text_policy_configuration_required');
    return { version: TEXT_VERSION, preset: v.preset, presetVersion: 1, question: text(v.question, 1000), positive: text(v.positive, 2000), negative: text(v.negative, 2000), exceptions: text(v.exceptions, 1000), contextRequirements: text(v.contextRequirements, 1000), requirePromotion: v.requirePromotion, configured: v.configured };
}
export function textBoundary(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim())
        return 'text_empty_or_unavailable';
    if (value.length > TEXT_LIMITS.characters || new TextEncoder().encode(value).length > TEXT_LIMITS.bytes)
        return 'text_over_limit';
    if (new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) !== value)
        return 'text_invalid_unicode';
    return null;
}
export interface TextEvidence {
    modality: 'text';
    promptVersion: typeof TEXT_VERSION;
    definition: TextDefinition;
    sampleSha256: string;
    correlationId: string;
    normalizationVersion: 'utf8-exact-v1';
    decision: {
        ruleRevision: number;
        ruleThreshold: number;
        actionFloor: number;
        effectiveThreshold: number;
        approvalFingerprint: string | null;
    };
    eligible: boolean;
    status: 'detected' | 'not_detected' | 'insufficient_evidence';
    blockedReasons: string[];
    context: string;
    promotionProbability: number | null;
    sufficientProbability: number | null;
    verification?: {
        probability: number;
        eligible: boolean;
        context: string;
        promotionProbability: number;
        sufficientProbability: number;
    };
}
