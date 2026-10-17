# Configurable image content analysis

Image content analysis (`type: content`) evaluates an administrator-defined observable yes/no policy without reference images. It is distinct from reference identity/similarity and any-image rules. Saved thresholds and pinned server models are preserved. A reference hash proves equality only and never answers a content question.

## Official contract checked October 17, 2026

Sources: [images](https://docs.typesafe.ai/images), [API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), [Noul](https://docs.typesafe.ai/primitives/noul), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Box](https://docs.typesafe.ai/primitives/box).

Content supports pinned `jev-1.13.0` and `jev-1.14.0`. Saved models are not rewritten. Image support remains experimental. Multipart requests use the image danger-zone header and independently evaluable typed questions. Existing bounded downloads, JPEG normalization, 20-second request timeout, three-attempt retry limit, daily quota, queue and 128 KiB response cap remain in force. Provider image limits include 280–1568 pixels per side, 16 MiB per image and 32 MiB request/expanded sizes; normalization applies stricter application limits.

## Definition and templates

The definition contains `version: image-content-v1`, `preset`, `presetVersion: 1`, `question`, `positive`, `negative`, `exceptions`, `contextRequirements`, `contextSource`, `requirePromotion`, `requireReadableText`, and diagnostic `supporting` predicates. Shared validation rejects unknown fields, unsupported versions, invalid enums, duplicate identifiers and overlong definitions. Every field participates in approval binding.

Editable templates cover scams/fraud, phishing, impersonation/social engineering, financial pressure, suspicious software instructions, harassment, threats/coercion, privacy, promotion, community conduct, sensitive-content triage, context and custom questions. Each supplies inclusion criteria, exclusions and textual examples. Only enabled selected rules run. Community/custom templates must be made specific to the server before use.

The scam predicate asks whether an image contains an apparent deceptive solicitation seeking money, credentials, access, sensitive information or another benefit through misleading claims or impersonation. Eight diagnostic predicates cover credentials, advance fees, authority, pressure, returns, diversion, warning and insufficient evidence. They never become independent sanctions.

Visible words, screenshots, nested speakers, memes, captions, signs, layout and branding are evaluated together. A QR code, cryptocurrency mention, urgency, logo or unfamiliar language alone is insufficient. No identity, ownership, factual truth, legality, age or private intent is verified. Static screenshots cannot establish repeated behavior.

## Exact decision mapping

Each request batches a primary Noul, promotion Noul, readability Choice, context Choice and up to eight diagnostic Nouls. Questions cannot read each other's answers. Noul answers must be finite probabilities in [0,1]. Choice answers must select a configured option and supply a valid full distribution and confidence. Category confidence is not treated as the selected category's probability. Score and Box parsers follow documented shapes, but neither is requested or used for sanctions. Localization/extraction are disabled: no displayed box, OCR transcription, QR decoding, URL visiting or command execution.

`effectiveThreshold = max(rule.threshold, settings.thresholds[rule.action])`; `meetsThreshold = primaryProbability >= effectiveThreshold`. Standard is 0.70, Strict 0.90, Custom 0.5–1.0 inclusive. Default floors are 0.70 for none/review/warn/delete and 0.90 for timeout/kick/ban. Floors remain editable with timeout <= kick <= ban validation. These are starting points, not accuracy guarantees. Any-image thresholds remain inapplicable.

Eligibility requires the primary predicate and required gates to pass. Partially readable text, insufficient detail, unsupported input and insufficient context abstain. No visible text is allowed only when readable text is not required. When promotion is required, its Noul must independently meet the same effective threshold and context must be solicitation or endorsement. Clear warning/reporting/education/satire/quotation does not satisfy that gate. Ambiguous promotion or unreadability routes to review. Diagnostics never override gates. The primary probability is preserved rather than combined with correlated outputs.

Second verification repeats the full typed assessment. Both calls must be eligible; conflicts suppress punishment and retain separate probabilities. Failed, malformed, late, over-budget or incomplete evaluations suppress the whole message's punitive decision. Ordering remains priority first, then individual, group, any-match, content, any-image, then rule ID.

## Context and privacy

Image-only is the default. Posting text requires both server `contentMessageContext: true` and rule `contextSource: posting_message`. Only the live posting message is used. Missing context or more than 2,000 characters fails explicitly, without truncation. Gateway jobs discard text. No history, private messages or unrelated attachments are ingested. Author text is labeled separately from trusted moderator policy. Embedded instructions are untrusted evidence. Nested speakers are not automatically attributed to the uploader.

Evidence stores the policy snapshot, typed decisions, model, prompt/preset versions, sample digest/normalization version, context source/digest, request correlation and verification. Raw posting text and uploaded bytes are not retained. Do not place real secrets in policy definitions. Existing tenant isolation, permissions, retention and audit controls apply. Notifications and CSV event exports do not include detected text or posting context. Provider retention is governed separately by TypeSafe's service terms.

## Approvals and persistence

New content rules, including conversions, start with automatic enforcement off. Saving clears approval; preset/threshold changes cannot enable enforcement. Permissions, scopes, exemptions, bot/webhook controls, deployment acceptance, global enforcement, calibration and high-impact safeguards are reused.

Fingerprints bind the full definition, actions, thresholds, model, context selection, prompt/combination version and normalization version. Content fingerprints canonicalize JSON keys for both databases; existing reference fingerprints are preserved. Changes invalidate evidence and approval. Abstaining calibration samples cannot count toward approval. Posting context is rechecked before execution; changes suppress action. Calibration deduplicates the image/context combination.

PostgreSQL JSONB and MySQL JSON records support additive versioned fields; no SQL migration or saved-record rewrite is needed. Missing-only fallback adds `contentMessageContext: false`. Database tests cover content round trips, isolation and fingerprint stability. Disable/remove content rules before rollback to code that does not understand this rule type.

## Resource use and costs

Caps: eight enabled content rules, 96 questions across them, eight diagnostics per rule, 2,000 context characters; 1,000 characters for question/exceptions/context requirements, 2,000 each for positive/negative criteria, 500 per diagnostic. All enabled rules must fit: exceeding a cap fails instead of reporting partial success. The evaluation deadline is 120 seconds. Optional image examples, crops, extraction and localization are not implemented and have zero budget.

Each rule's compatible questions share one request; different rules retain separate policy/context boundaries. Attempts, retries and verification use the existing durable ledger. Content attempts include `analysisKind: content`, `ruleIds` and correlation ID. Input totals are charged once per request, never once per question. Unknown usage, missing prices and partial estimates remain explicit. Test estimates read at most the latest 100 daily attempts; pagination/unpriced attempts mark estimates partial. The full Cost & Usage ledger remains authoritative.

## Testing and acceptance

`npm test` validates software contracts, not model accuracy. `scripts/browser-smoke.py` uses offline synthetic transport at desktop/mobile sizes. `fixtures/content/manifest.json` contains generated PNG/JPEG challenge cases with labels, languages, categories and tuning/held-out splits. Regenerate with `node scripts/generate-content-fixtures.mjs`. These are authored synthetic examples, not verified fraud ground truth; ambiguous/unreadable labels are null.

After explicit authorization for paid evaluation, supply `TYPESAFE_EVAL_KEY` securely, set `ALLOW_PAID_CONTENT_EVALUATION=true`, and run `npm run evaluate:content -- fixtures/content/manifest.json`. Optional `CONTENT_EVAL_THRESHOLD`, pinned `JEV_MODEL` and `JEV_EVAL_PRICING` configure the run. Reports contain attempts, cost coverage, versions/digests and metrics by category/language/split. Precision/recall exclude abstentions and ambiguous labels; coverage accompanies them. Failures preserve completed results and mark the run incomplete. Keep tuning and held-out data separate.

No paid evaluation or production acceptance is implied by CI. Before enforcement, evaluate representative human-reviewed held-out data, inspect false positives/negatives and coverage, calibrate the pinned model, validate in a dedicated Discord guild and approve the current policy. Depicted content is not proof that the uploader committed wrongdoing.
