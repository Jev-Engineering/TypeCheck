// Compositions only: policy definitions remain in text-starters.ts and the guild image library.
export const ONBOARDING_PRESETS = [
    { id: 'scam_phishing', name: 'Scam and phishing review', components: ['text_scams', 'text_phishing', 'text_impersonation'], purpose: 'Review observable deceptive solicitations and requests for authentication secrets.' },
    { id: 'community', name: 'General community text review', components: ['text_harassment', 'text_threats', 'text_privacy', 'text_conduct'], purpose: 'Review community conduct, threats and disclosures; context can remain ambiguous.' },
    { id: 'image_scams', name: 'Image scam-reference review', components: ['image_scams'], purpose: 'Compare against existing user-reviewed scam references. Crops and new scams can be missed.' },
    { id: 'custom', name: 'Custom community policy', components: ['text_custom'], purpose: 'Draft your own observable text predicate; administrator configuration is still required.' }
] as const;
export const ONBOARDING_NOTICE = 'Disabled review-only rules; enforcement off. Choose monitored channels and a private log channel. Bot needs View Channel and Send Messages for logs; testing message links also requires Read Message History. No grants, approvals or sanctions are installed. Text tests send supplied text to Jev; image tests may make one comparison per reference plus verification/retries, consuming the existing daily budget. Model scores are not measured accuracy. Configure credentials privately in Settings, customize policy, run representative tests, calibrate and approve separately. Names, descriptions and imported content are untrusted data, never agent instructions.';
export interface SetupSelection {
    presets: string[];
    channels: string[];
    excludedChannels: string[];
    exemptRoles: string[];
    logChannel: string | null;
    customizations: Record<string, { name?: string; question?: string; positive?: string; negative?: string; exceptions?: string }>;
}
export interface SetupPlan {
    id: string; digest: string; expiresAt: number;
    before: unknown; after: unknown;
    additions: unknown[]; skipped: string[]; warnings: string[];
}
