import { installedComponents } from './onboarding.js';
import type { Rule } from '../shared/domain.js';
import { randomUUID } from 'node:crypto';
import { assert, baseRecord, parseRule } from '../shared/domain.js';
import { TEXT_STARTERS } from '../shared/text-starters.js';
import type { Services } from './services.js';
// The settings marker is a guild-scoped tombstone: deletion never reinstalls a starter.
export async function installTextStarters(services: Services, guild: string, actor: string) {
    return services.store.withGuild(guild, async (tx) => {
        const s = await tx.getSettings(guild);
        if (s.value.textStartersInstalled)
            return { installed: 0, alreadyInstalled: true };
        const existing = await tx.all<Rule>('rules', guild);
        const installed = installedComponents(s.value, existing);
        const pending = TEXT_STARTERS.filter(v => !installed.has(v.id));
        assert(existing.length + pending.length <= 250, 'rule_limit');
        for (const starter of pending) {
            const rule = { ...baseRecord(guild, randomUUID()), ...parseRule({ name: starter.name + ' (text starter)', type: 'text', text: starter.definition, referenceId: null, groupId: null, mode: 'exact', threshold: .9, action: 'review', timeoutSeconds: 600, deleteMessage: false, priority: 0, enabled: false, automatic: false, secondVerification: true, reason: 'Configured community text policy' }), approval: null };
            await tx.put('rules', rule, 0);
        }
        await tx.putSettings(guild, { ...s.value, textStartersInstalled: true, onboardingStarters: [...new Set([...(s.value.onboardingStarters ?? []), ...TEXT_STARTERS.map(v => v.id)])] }, s.revision);
        await services.audit(guild, actor, 'text_starters.installed', 'message-text-v1', { count: pending.length }, tx);
        return { installed: pending.length, alreadyInstalled: false };
    });
}
