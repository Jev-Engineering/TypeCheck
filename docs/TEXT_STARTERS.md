# Editable text starters

Canonical definitions and positive/negative/ambiguous examples: [shared/text-starters.ts](../shared/text-starters.ts). Activity → Rules & tests → Text starter policies previews each definition before customization. Administrators can customize one or explicitly install the disabled set for an existing or new guild. Nothing installs automatically at login.

| Stable ID (version 1) | Family | Additional configuration |
|---|---|---|
| text_scams | Scams/deceptive solicitation | Tune to community examples |
| text_phishing | Phishing/credential theft | Tune to community examples |
| text_impersonation | Impersonation/social engineering | Tune to community examples |
| text_software | Software/security disabling | Tune to community examples |
| text_harassment | Targeted harassment | Tune to community examples |
| text_threats | Threats/coercion | Tune to community examples |
| text_privacy | Sensitive-information exposure | Review synthetic/redacted lookalikes |
| text_promotion | Spam/prohibited promotion | Concrete prohibition/context required |
| text_conduct | Community conduct | Concrete prohibition/context required |
| text_custom | Custom observable policies | Predicate/inclusions/exclusions required |

Every starter has a yes/no predicate, inclusions, exclusions, exceptions, within-message context requirements and synthetic examples. No readability/OCR/image gate applies. A single message cannot establish repetition, private intent or actual domain ownership. Reserved `.example` addresses and synthetic identities are used. Warnings, reports, education, quotations and injection attempts have negative/ambiguous fixtures.

Installation holds the guild transaction lock, writes all ten rules and an immutable settings marker atomically, and is idempotent under concurrent requests. Existing rules are preserved. Deleting a starter never reinstalls it; pressing Install again is a no-op. New versions never silently overwrite customization. Every installed rule is disabled, nonautomatic, unapproved and review-only. Installation is not calibration or acceptance.

The 33 project-owner-reviewed scam reference images and manifest in `data/scams` are unchanged. Text samples are separately synthetic, with no inherited user-review or accuracy claims. See [text boundaries/privacy](TEXT_MODERATION.md) and [evaluation procedure](../fixtures/text/README.md).
