# Native message text moderation

`text` rules (`message-text-v1`) classify the posting message directly. `content` rules (`image-content-v1`) classify an image, optionally with enabled posting-message context. Reference rules compare images. Text inside an image is never treated as native message text, and text is never rendered into an image. Historical scans remain image-only.

## Provider contract

Official sources checked October 17, 2026: [quickstart](https://docs.typesafe.ai/introduction/quickstart), [models](https://docs.typesafe.ai/models), [primitives](https://docs.typesafe.ai/primitives). Text uses JSON `POST https://api.typesafe.ai/v1/systemone`, Bearer authentication, `state.message` and four independent typed questions: primary, sufficient evidence, promotion and context. Supported pinned IDs are `jev-1.13.0` and `jev-1.14.0`; moving aliases are rejected. The parser requires exact question keys, requested model, finite Noul probabilities, valid complete Choice distribution, and nonnegative integer usage. No image danger-zone header is sent for text. Published contract verification is not a successful live call or classifier-quality evaluation.

Trusted administrator instructions contain the predicate, positive criteria, exclusions, exceptions and contextual requirements. Message content is evidence in `state`. Questions reject embedded instructions and fake system roles, preserve nested speaker attribution, and distinguish solicitation/endorsement from warnings, reports, education and quotations. Separate sufficient-evidence and optional promotion gates are composed in code. These safeguards do not prove resistance to every adversarial input. Representative human-reviewed evaluations remain necessary.

## Input boundaries

Only the current guild message's `content` is supported. Well-formed Unicode, Markdown, literal links and code blocks are submitted exactly, without decoding markup or fetching targets. Limits: 4,000 UTF-16 code units, 16,000 UTF-8 bytes, eight active text rules, 48,000 serialized request bytes per rule. Exceeding a limit abstains/errors; no silent truncation. Unsupported non-string, missing, empty and whitespace-only text produce insufficient evidence without a provider request. Discord can redact content to an empty string, so empty and unavailable cannot reliably be distinguished; neither is classified safe. Embeds, stickers, audio, video, files, linked sites, DMs, history and unrelated messages are not native text input. Obfuscated text is preserved; language-specific performance is unvalidated.

Bots/webhooks follow existing independent opt-ins. Own-bot messages are excluded. Exempt roles, administrators and owners remain protected. Webhook identities cannot receive user sanctions. Same-guild test links verify the requesting member's current read permission and refetch only that message.

## Lifecycle and mixed messages

Gateway creates/edits pass transient text to ingestion; partial edits are refetched. Durable jobs contain IDs, supported attachment metadata and `textDigest` only. Digest: SHA-256 of `text:` plus exact text, or a fixed unavailable marker; normalization `utf8-exact-v1`. Job signatures add this digest to sorted attachment IDs, deduplicating delivery while permitting edited-message jobs. Workers refetch current content, validate guild/author and requeue a newer digest instead of analyzing obsolete evidence. Deleted/inaccessible messages cannot be punished. Delete events do not enqueue classification; pending work discovers deletion by refetch. Resume/reconnect and leadership recovery use existing durable jobs and controller locks. No history is fetched to fill Gateway gaps.

Each rule receives its intended modality. Results accumulate and resolve once. Default precedence: individual reference, group, any reference, image content, native text, any image; numeric priority overrides this order. Insufficient evidence can require review under that ordering. Provider failure suppresses the incomplete whole-message decision. Current text is checked before action, even when an image wins, and again after preflight before dispatch. A Discord read-to-mutation race cannot be eliminated. Delete followed by sanction uses the verified pre-delete snapshot after this worker's successful deletion. Durable `user` and `delete` slots prevent duplicate sanctions across retries, edits and recovery. Matching digest/policy evidence can be reused without another text call.

## Defaults, approval and resource bounds

`textModerationEnabled` defaults false, including legacy settings. Administrators create/edit text policies; new text rules are nonautomatic. Explicit starter installation creates disabled review-only rules. Enable the server text switch and selected configured rules deliberately, test representative positives/negatives, then approve the current fingerprint. Model, modality, prompt, policy fields, promotion requirements, thresholds and text switch bind approval. Image calibration never authorizes text. Duplicate samples cannot inflate calibration; conflicting labels and false positives block approval. Community/custom templates require concrete replacement criteria and configuration confirmation. Installation grants no approval.

Effective threshold is max(rule threshold, action floor). Insufficient evidence abstains to review. High-impact switches, severe second verification, member protections, deployment acceptance, permissions and global enforcement remain mandatory. Second checks may share model errors; agreement is not independent proof.

Two native text evaluations maximum are admitted per Services instance; excess tests fail safely. Each attempt uses shared durable credential/account throttling, cooldown, daily guild/account quotas and request accounting. Existing production retries defer durable jobs with bounded retry counters; direct clients retry at most three times. Evaluation deadline: two minutes; network timeout: 20 seconds per attempt; response cap: 128 KiB. No applicable enabled text rule means no text job/call. Estimated costs include retries/verification and use administrator rates; they are not invoices. Paid evaluations require separate authorization.

## Privacy, evidence and retention

Raw submitted text exists transiently in Gateway/REST/provider request memory. SQL jobs, evaluations, calibration, audits, event exports, usage, notifications and safe errors exclude it. The test UI clears pasted text after success and does not echo it in results. Policy fields, moderation reasons and approval notes are administrator-authored configuration: never paste real secrets or sensitive messages into them. Provider processing transmits selected content outside Discord; review provider terms/retention separately. This implementation does not establish provider zero retention.

Evidence includes modality, exact digest/normalization, rule revision/full versioned policy, model, prompt version, thresholds, approval fingerprint, context label, probabilities, blocked reasons, verification and usage correlation ID. Digests reveal equality and are not anonymization. Existing guild capabilities, table retention and guild deletion apply. No new raw-content store or SQL migration is introduced.

## Recovery and rollback

Schema remains 001–003. New data is additive JSON using existing transactions, slots and recovery locks. Current code reads legacy guild settings/rules without changing image fingerprints or enabling text. PostgreSQL/MySQL tests cover roundtrip, concurrent installation, deletion tombstones, digest-only edit deduplication and transaction rollback.

Older executables may reject new JSON setting keys. Before a separately authorized downgrade, pause enforcement/workers, back up data, archive text rules/evidence, and remove `textModerationEnabled` and `textStartersInstalled` from saved settings in a reviewed guild-scoped maintenance transaction. Preserve the installation tombstone in the backup and restore on upgrade so deleted starters do not return. Do not drop tables or relabel calibration. No automatic downgrade script or production rollback is claimed.

## Remaining acceptance

Automated tests assert software behavior using mocked scores. Separately authorize dedicated-guild testing of creates/edits/deletes, restricted channels, bots/webhooks, intent redaction, reconnect gaps, permissions, stale reads and moderation. Independently adjudicate tuning/held-out text cases against the pinned provider. Public hosting, security review and deployment remain separate gates. Keep `ACCEPTANCE_APPROVED=0` until applicable gates pass.
