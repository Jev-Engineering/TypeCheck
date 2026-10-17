import { assert, bool, object, onlyKeys, text } from './domain.js';

export const CONTENT_VERSION = 'image-content-v1';
export const CONTENT_MODELS = ['jev-1.13.0', 'jev-1.14.0'];
export const CONTENT_LIMITS = { rules: 8, supporting: 8, context: 2000, questions: 104, examples: 0, crops: 0 } as const;
export interface ContentDefinition {
    version: typeof CONTENT_VERSION;
    preset: string;
    presetVersion: 1;
    question: string;
    positive: string;
    negative: string;
    exceptions: string;
    contextRequirements: string;
    contextSource: 'image_only' | 'posting_message';
    requirePromotion: boolean;
    requireReadableText: boolean;
    supporting: { id: string; question: string }[];
}
export function parseContent(value: unknown): ContentDefinition {
    const v = object(value);
    onlyKeys(v, ['version', 'preset', 'presetVersion', 'question', 'positive', 'negative', 'exceptions', 'contextRequirements', 'contextSource', 'requirePromotion', 'requireReadableText', 'supporting']);
    assert(v.version === CONTENT_VERSION && v.presetVersion === 1, 'unsupported_content_version');
    assert(typeof v.preset === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v.preset), 'invalid_content_preset');
    assert(v.contextSource === 'image_only' || v.contextSource === 'posting_message', 'invalid_content_context');
    assert(Array.isArray(v.supporting) && v.supporting.length <= CONTENT_LIMITS.supporting, 'content_supporting_limit');
    const supporting = v.supporting.map(raw => {
        const s = object(raw); onlyKeys(s, ['id', 'question']);
        assert(typeof s.id === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(s.id), 'invalid_signal_id');
        return { id: s.id, question: text(s.question, 500) };
    });
    assert(new Set(supporting.map(s => s.id)).size === supporting.length, 'duplicate_signal_id');
    return { version: CONTENT_VERSION, preset: v.preset, presetVersion: 1, question: text(v.question, 1000), positive: text(v.positive, 2000), negative: text(v.negative, 2000), exceptions: text(v.exceptions, 1000), contextRequirements: text(v.contextRequirements, 1000), contextSource: v.contextSource, requirePromotion: bool(v.requirePromotion), requireReadableText: bool(v.requireReadableText), supporting };
}
export const READABILITY = {
    no_visible_text: 'No visible text.', readable: 'The policy-relevant text is readable.',
    partially_readable: 'Some policy-relevant text is unreadable.', insufficient_detail: 'Too little visual detail to assess.',
    unsupported: 'The input cannot be assessed.'
};
export const CONTEXT = {
    solicitation: 'The current post visibly solicits participation.', endorsement: 'The current post visibly endorses the depicted conduct.',
    warning: 'Warning against the depicted conduct.', reporting: 'Reporting or asking for help assessing depicted conduct, including asking whether this is a scam.',
    education: 'Educational discussion.', satire: 'Satirical treatment.', quotation: 'Quotation without visible endorsement.',
    none: 'No relevant context.', other: 'Another context.', insufficient_context: 'Cannot determine the relationship of the current post to depicted content.'
};
export interface ContentEvidence {
    decision: {
        ruleRevision: number; ruleThreshold: number; actionFloor: number; effectiveThreshold: number;
        action: import('./domain.js').Action; priority: number; automatic: boolean; secondVerification: boolean;
        deleteMessage: boolean; timeoutSeconds: number; approvalFingerprint: string | null;
        globalEnforcement: boolean; highImpactEnabled: boolean; contextEnabled: boolean; uncertain: 'review' | 'ignore';
    };
    definition: ContentDefinition;
    promptVersion: typeof CONTENT_VERSION;
    correlationId: string;
    contextSource: ContentDefinition['contextSource'];
    contextSha256: string | null;
    sampleSha256: string;
    normalizationVersion: string;
    readability: keyof typeof READABILITY;
    context: keyof typeof CONTEXT;
    depictedProbability: number;
    promotionProbability: number;
    signals: Record<string, number>;
    eligible: boolean;
    status: 'detected' | 'not_detected' | 'insufficient_evidence';
    blockedReasons: string[];
    verification?: { probability: number; eligible: boolean; readability: string; context: string; promotionProbability: number; depictedProbability: number; signals: Record<string, number>; blockedReasons: string[] };
}
const exclusions = 'Exclude reporting, warnings, education, satire and quotation without endorsement. A single cue, QR code, cryptocurrency reference, unfamiliar language, urgency or logo alone is insufficient. Do not infer identity, ownership, legality, truth, age, private intent or behavioral repetition from a screenshot.';
const families = [
    ['scams', 'Scams and fraud', 'Does the submitted image contain an apparent deceptive solicitation intended to obtain money, credentials, account access, sensitive information, or another benefit through misleading claims or impersonation?', 'Apparent advance fees, fake prizes or giveaways, fraudulent refunds, recovery scams, fake support, job/task scams, investment inducements or marketplace payment diversion with both a solicitation and observable misleading claims.', 'A normal invoice, legitimate-looking giveaway with no fee or deceptive claim, or a scam warning.'],
    ['phishing', 'Phishing and credential theft', 'Does the image solicit authentication secrets or direct the recipient to an apparent credential-harvesting process?', 'Password, authentication/recovery code or seed-phrase requests; apparent fake login/verification or account takeover instructions.', 'Ordinary login UI alone, password safety advice or a report of phishing.'],
    ['impersonation', 'Impersonation and social engineering', 'Does the image depict apparent authority-based social engineering to bypass normal procedures?', 'A claimed staff/support identity or fabricated authority paired with secrecy demands or instructions to bypass safeguards.', 'A brand logo or support conversation alone does not establish impersonation.'],
    ['financial_pressure', 'Financial pressure', 'Does the image contain coercive or implausible financial inducements?', 'Guaranteed returns, coercive payment threats, or urgent unusual transfers/gift-card demands tied to pressure.', 'Benign payment reminders, ordinary commercial notices or cryptocurrency discussion alone.'],
    ['software', 'Suspicious software instructions', 'Does the image ask a recipient to weaken protections or run untrusted software?', 'Instructions to disable safeguards, install unknown tools, grant remote access or execute commands from an untrusted solicitation.', 'Documented benign administration, security education or a screenshot merely showing code.'],
    ['harassment', 'Harassment and abuse', 'Does the image depict targeted harassment or degrading abuse?', 'Targeted insults, bullying, discriminatory attacks or sexual harassment observable in the image.', 'Criticism of ideas, non-targeted profanity or reporting abuse.'],
    ['threats', 'Threats and coercion', 'Does the image depict threats or coercive demands?', 'Threats of violence, blackmail, extortion, intimidation or doxxing threats directed at a target.', 'Fiction, quotations, warnings and reports without endorsement.'],
    ['privacy', 'Privacy and sensitive information', 'Does the image visibly expose apparent private or sensitive information?', 'Apparent credentials, private contact details, financial details, identity documents, home addresses or private conversations.', 'Public business contacts, clearly redacted data or obvious synthetic examples. Do not transcribe detected secrets.'],
    ['promotion', 'Spam and promotion', 'Does the image contain a solicitation prohibited by the configured community policy?', 'Unsolicited advertising, referral solicitation, recruitment, promotional templates or off-topic sales when the configured context establishes prohibition.', 'Allowed commercial notices and ordinary recommendations. A static image cannot establish repetition.'],
    ['conduct', 'Community conduct', 'Does the image violate the specific observable community restriction in the positive criteria?', 'Administrator must specify prohibited trading, unauthorized solicitation, off-topic content, spoilers or channel-specific restrictions before enabling.', 'Allowed discussion and cases lacking the required community context.'],
    ['sensitive', 'Sensitive-content triage', 'Does the image depict the configured sensitive category requiring contextual review?', 'Sexual content, graphic violence or self-harm encouragement observable in the image; administrator narrows the category before use.', 'Health education, prevention, reporting and ambiguous details; do not infer age.'],
    ['context', 'Context and intent', 'Does the image visibly warn about, report or educate about potentially harmful content?', 'Explicit warning, report, educational explanation, satire or quotation with visible contextual framing.', 'Solicitation or endorsement without a warning or educational frame.'],
    ['custom', 'Custom questions', 'Does the image satisfy the administrator-defined observable content policy?', 'Replace with specific observable inclusion criteria before enabling.', 'Replace with explicit exclusions and counterexamples before enabling.']
] as const;
export const CONTENT_PRESETS = families.map(([id, family, question, positive, negative]) => ({
    id, family, examples: { positive, negative },
    definition: { version: CONTENT_VERSION, preset: id, presetVersion: 1, question, positive, negative,
        exceptions: exclusions, contextRequirements: 'Assess visible evidence only. Preserve speaker attribution in nested screenshots. Insufficient evidence requires review.',
        contextSource: 'image_only', requirePromotion: !['privacy', 'sensitive', 'context', 'custom'].includes(id), requireReadableText: !['sensitive', 'custom'].includes(id),
        supporting: id === 'scams' ? [
            ['credentials', 'Does the image request credentials, authentication codes or recovery secrets?'],
            ['advance_fee', 'Does the image request payment to obtain a prize, job, refund or recovered asset?'],
            ['authority', 'Does the image use apparent impersonation or fabricated authority?'],
            ['pressure', 'Does the image use threats, artificial urgency or secrecy to induce compliance?'],
            ['returns', 'Does the image make implausible or guaranteed financial-return claims?'],
            ['diversion', 'Does the image direct recipients away from a normal transaction or support process?'],
            ['warning', 'Does the image report or warn about a suspected scam?'],
            ['insufficient', 'Is there insufficient readable evidence for assessment?']
        ].map(([id, question]) => ({ id: id!, question: question! })) : []
    } as ContentDefinition
}));
