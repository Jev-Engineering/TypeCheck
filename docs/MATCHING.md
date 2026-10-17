# Matching, calibration and costs

## Durable usage and estimated spend

The guild attempt ledger supplies cost analytics; evaluation records remain decision evidence, not billing records. Each actual retry, second verification and credential validation request is recorded separately; reused comparisons incur no extra attempt. Valid input tokens are captured even when the answer fails strict moderation validation. Earlier successful usage survives a later failure. Missing usage stays unknown and failed/timed-out requests are never described as free.

Overview and Cost & Usage show **Estimated** input-token costs at administrator-entered, revisioned model rates with currency-separated totals and coverage counts. No default price is invented. Historical daily totals are legacy aggregates, displayed separately without fabricated model attribution or costs. Rates are snapshotted at attempt start and do not reprice history or change actual provider prices. There is no currency hard cap or enforcement change. See [COSTS.md](COSTS.md) for exact rounding, UTC ranges, retention, provenance and crash limits.

The standalone CLI records `usageAttempts` and safe failures in `evaluation-results.json`, including partial runs. Optional `JEV_EVAL_PRICING` accepts the API pricing JSON format and uses the same integer calculation. It never opens a database or imports results into guild analytics. Tests use fake keys and mocked responses only. Real CLI runs remain charged provider calls requiring explicit authorization.

## Provider boundary

The adapter sends two normalized images per comparison through the official System One multipart protocol, using a Noul question and the explicit image header. It validates the model identifier, answer type, finite probability and usage fields. No free-form generated answer is parsed as an action. TypeSafe marks image support experimental; compatibility and accuracy can change [J1, J2].

`jev-1.14.0` is the default explicit model ID. Aliases are intentionally not accepted as a configuration substitute. A model change invalidates prior rule approval. The supported-model listing and image-specific documentation should both be checked when upgrading [J3].

The app uses its own private reference store. Jev is not treated as a persistent hosted image library. Comparisons are pairwise, with per-evaluation reuse for identical reference/mode combinations; no approximate candidate index silently excludes references. Each attachment has a 120-second evaluation deadline between calls, a guild daily request budget, and provider retry limits. A call already in flight can extend the elapsed time beyond that deadline.

## Modes and precedence

Exact asks whether the same visual image is present, not a different photograph of the same subject. Transformed permits configured classes of copy-like changes in the fixed prompt: resizing, compression, small crops, borders, overlays and minor color changes. Partial asks whether a copy appears within a composition; it does not produce a bounding box. Semantic is separately enabled and review-only.

Higher numeric rule priority wins. Ties favor individual-image, group, any-reference and then any-image rules, followed by stable rule ID. All comparisons are recorded; one effective user-level action is selected for a message. Message deletion can accompany that action. Selecting a less-severe/high-priority rule can intentionally suppress a lower-priority severe rule; severity does not silently override administrator priority.

A positive Jev candidate must satisfy the greater of the rule threshold and action floor. If no rule qualifies for its action, an eligible comparison enters fallback human review only when `settings.uncertain` is `review` and `settings.thresholds.review <= probability < max(rule.threshold, settings.thresholds[rule.action])`. Below the review threshold it is not escalated; `ignore` disables this fallback. Equality qualifies at either threshold. Explicit review rules still qualify normally at their effective action threshold, including under `ignore`.

Action-qualified rules take precedence over all fallback candidates. Within either set, the rule priority/type/ID ordering above applies. Within a rule, choose highest probability, then ascending attachment ID and reference ID; otherwise identical conflicting verification flags favor unverified, preserving the execution gate. Both Jev paths reject nonfinite/out-of-range probabilities and wrong-model results, and exclude disabled rules and disabled semantic/any-image modes.

A review threshold equal to or above a rule's effective action threshold creates an empty fallback band for that rule; it does not raise the action floor or reject existing stored settings. This also applies when the review threshold exceeds an action floor but a higher rule threshold still leaves a review band. No migration or new cross-threshold validation is required.

**Review routing:** fallback uses the saved review threshold, rather than the historical hardcoded 0.5. New servers default to 0.70; existing saved review thresholds (including 0.8) are preserved. Scores below the configured review threshold do not create fallback review events. Existing events are retained.

Fallback review is nonpunitive (`execute=false`, no deletion). The worker persists an open moderation event, visible under Activity **Logs > Moderation events**; authorized moderators can confirm, dismiss or mark it false positive in Details. The last option disables the associated rule and clears approval. Raw image evaluations remain available even when no comparison is escalated. A failed second verification uses the conservative minimum probability and may enter the review band, but cannot authorize punishment. Provider errors never become positive results. An incomplete multi-image evaluation suppresses punitive dispatch for the whole message because rule precedence could otherwise be resolved incorrectly.

## Configurable match thresholds

Shared configuration in `shared/domain.ts` supplies **Standard (0.70)** for general matching and **Strict (0.90)** for cases requiring stronger confidence. These are practical starting points from experience; suitability depends on the domain, model and images. **0.90 is a stricter threshold, never a guarantee of accuracy or a claim of 90% accuracy.** Calibrate on representative examples.

New rules start at 0.70. New server action floors are 0.70 for none, review, warn and delete, and 0.90 for timeout, kick and ban. The Activity rule editor offers Standard, Strict and Custom alongside an editable numeric value. Administrators can change each floor in Settings. Values must be finite numbers in the inclusive range 0.5–1.0, with timeout <= kick <= ban; other action floors are independent.

For reference matching, `effective threshold = max(rule threshold, action floor)`, and a score qualifies when `score >= effective threshold`. For example, a Standard timeout rule uses max(0.70, 0.90) = 0.90: 0.90 qualifies and 0.899999 does not. A custom rule value of 0.93 with a 0.90 floor uses 0.93. Qualification still requires every enforcement safeguard. Tests show the returned score (the conservative combined score after second verification), configured rule value, action floor, effective value and inclusive comparison result; tests never execute sanctions.

Existing saved values, including the older 0.95/0.97/0.99/0.999 floors, remain unchanged. Missing stored fields receive defaults on read without rewriting records. API updates preserve omitted existing thresholds; explicitly invalid values are rejected. No migration resets servers or rules. Threshold edits do not enable enforcement: rule saves clear approval, and floor changes make prior fingerprints stale.

Any-image rules do not use match thresholds or Jev similarity scores. Their test score is a synthetic presence marker, and effective threshold / meets-threshold fields are null. Explicit any-image enablement, approval and enforcement gates still apply. Uncertain-review routing retains the configured-floor behavior from #6 / #8.

## Approval gates

Punitive reference rules require a current administrator-approved fingerprint tied to rule content, reference content/revisions, model, prompt version and thresholds. Saving a rule clears approval; changing a dependency makes approval stale.

For normal punitive rules the current evidence needs at least one unique positive and one unique negative. Kick/ban need at least five distinct positive and twenty distinct negative samples, a true-positive observation, no observed false positives, high-impact enablement and a second verification. The second probability is combined conservatively with the first. Re-uploading the same normalized bytes cannot pad the sample count; contradictory labels are rejected. Any-image rules require explicit administrator approval/enablement but do not need Jev calibration.

**These counts are operational safeguards, not validated error-rate guarantees.** Twenty negatives cannot establish the very small false-positive rate needed for unattended bans in a busy server. Both verification calls use the same model and may share the same failure. False positives remain possible even at 0.999. Production approval needs a representative held-out corpus, difficult negatives, image-instruction attacks, repeats, severe-action review and a monitored rollout. The default numerical thresholds are not empirical performance claims.

The provided synthetic manifest contains 32 cases: exact, transformed, partial and negative examples. The included images are original simple geometry, not a realistic community dataset. They have not been sent to Jev. Expand with labeled, authorized examples from the actual deployment; keep tuning samples separate from held-out evaluation.

## Run actual evaluation

After installing/building, create `.env` and set `TYPESAFE_EVAL_KEY` in a local shell or secrets manager. Run:

```bash
npm run evaluate -- fixtures/manifest.json
```

The script uses real provider calls, caps the manifest at 500 cases and total attempts at 1000, never calls Discord, and writes `evaluation-results.json` with model, per-case probability/label, usage and TP/TN/FP/FN by mode. Add that output to your deployment evidence only after execution. The CLI output does not automatically approve database rules; use the Activity's labeled test workflow for approvals.

## Budget and cost model

Reported Jev input tokens include image input; the image docs do not supply a reliable per-image estimator [J1]. The dashboard records actual reported input tokens and request attempts. Retries count against the configured daily request cap, and Activity tests/credential validation also consume that cap.

Estimate model spend as `(reported input tokens / 1,000,000) × your current billed input rate`, plus any other charges in your provider agreement. Consult current account pricing instead of assuming an old rate. Pairwise comparisons scale with submitted images × applicable references × required verification passes. Large libraries can exhaust the conservative time or request budget and produce operational failures, not automatic punishments. No currency-denominated hard cap is implemented.

Reference storage grows with normalized images; database costs grow with retained evaluation/audit rows and durable tombstones. Posted image bytes are not retained. Hosting, PostgreSQL, backup and outbound-network costs are separate from Jev usage.

[J1] https://docs.typesafe.ai/images

[J2] https://docs.typesafe.ai/api

[J3] https://docs.typesafe.ai/models

Consulted October 15, 2026.

## Deterministic normalized-content evidence

Before each eligible reference comparison, the evaluator compares SHA-256 of the existing normalization output: auto-oriented, metadata-stripped, 768×768 contain/white canvas, flattened baseline JPEG at quality 90. `hashVersion` identifies this pipeline plus a digest of the sorted sharp/native codec version map. Compare only equal, known versions. Decoder or encoder upgrades can intentionally reduce hash hits until source references are re-uploaded. Original files with different PNG encoding or stripped EXIF can produce equal normalized bytes; synthetic tests verify these cases. Crops, lossy recompression and watermarks in the tests differ. No perceptual hash, distance, embedding, approximate search or original-file identity claim is made.

A hit emits `provenance: exact_hash`, null probability/model, `verified: false`, reference ID/revision, hash version and a policy fingerprint. It bypasses `Services.call`, credential reads, reservation, provider attempts and token/cost accounting. `hashComparisons` counts handled rule/reference comparisons, not unique would-have-been provider attempts: normal reuse could also have avoided a call. Hypothetical token usage and monetary savings are unknown. Jev evidence has `provenance: jev`; older records without provenance remain readable. Any-image opt-in keeps its separate policy behavior.

Hash candidates use existing rule priority/type/ID precedence alongside qualifying Jev candidates. Probability automation/review bands apply only to Jev results (two-threshold issue #6 / PR #8). Exact evidence needs no numerical threshold, but it does need all execution safeguards. An unmet safeguard produces an open review with its reason (for example `exact_hash:verification_required` or `exact_hash:calibration_approval_required`), no deletion, and no additional Jev call. Semantic remains review-only. Deployment acceptance, member protections, action enablement, administrator approval, permissions and source/policy rechecks remain in force. Review confirmation still does not execute an action.

The fingerprint now includes the hash scheme and each eligible reference's content hash, object key, revision and hash version. This intentionally invalidates old approvals. Exact evidence is rejected if its binding no longer matches. New Jev evidence is also bound; legacy Jev records remain readable. Comparison reuse is confined to a single attachment evaluation and includes content/storage identity, mode, model and verification pass; each reused result is separately bound to its reference revision and policy; nothing persists across configuration changes. All required comparisons continue after a hash hit. A later provider failure retains partial evidence in the failed evaluation and suppresses whole-message execution.

Hash-only labeled tests store a deterministic prediction with null probability/model; they are excluded from Jev calibration counts, but any labeled hash false positive blocks approval. Administrators still need the existing positive/negative Jev calibration evidence (use representative non-identical normalized samples for the model path). Equality is matching evidence, not permission to punish. **Follow-up policy work:** any proposal for severe automatic actions based solely on hash evidence requires separately designed administrator approval/calibration/verification policy and acceptance; this PR does not authorize or implement that policy.

### Legacy references and backfill

Inspection found `sha256` computed over normalized JPEGs, but no persisted pipeline/native-codec version. Original uploads are not retained. Existing hashes therefore cannot safely be marked compatible. Re-normalizing retained lossy JPEGs is not equivalent to normalizing their original source. There is deliberately no backfill, migration or silent rewrite in this change: missing/incompatible versions use Jev. An authorized source re-upload through the existing revision-checked image API derives a fresh versioned hash; metadata-only edits preserve its existing version (or absence). PostgreSQL and MySQL already retain these fields in JSON records; no Store interface, index or schema change is needed.


## Content analysis

[Content analysis](CONTENT_ANALYSIS.md) adds reference-free questions, readability/context gates and distinct abstention states. Reference matching and any-image semantics are preserved. Image text is evidence, never trusted instructions or verbatim OCR.


### Calibration sample sources

The Activity Test dialog accepts local files, a same-guild Discord message link, or guild image-library selections. All retain the expected-label selector and existing evaluation, quota and cost ledger. Approval still deduplicates by normalized SHA-256 with unchanged thresholds. Identical reference samples produce `exact_hash` and do not count toward approval; use content rules or non-identical references. Deterministic false positives still block approval.

`POST /api/g/{guildId}/rules/{id}/test` accepts exactly one of `base64`, `messageUrl`, or `imageIds` (1-20 UUIDs), plus optional boolean `expected` and `context` (up to 2,000 characters). Uploads retain the single-result response; message/library requests return `{results: [...]}`. Each result includes `calibrationNote` (an explicit `exact_hash` exclusion note or null). Library access also requires `images.view`; records and objects are guild scoped. Older normalization versions require re-upload.

Message URLs use HTTPS on discord.com, canary.discord.com or ptb.discord.com with `/channels/guild/channel/message`. Requests check live `matching.test` and requester View Channel + Read Message History with channel overwrites before fetching. Threads use parent-channel permissions; private threads additionally require live membership or Manage Threads. Errors include `message_wrong_guild`, `message_not_found`, `message_read_permission_required`, `message_has_no_supported_images` and existing download/normalization byte and pixel limits. A batch can stop on a failed attachment after earlier samples completed; completed calls remain charged and labeled samples remain deduplicated on retry. Supported attachments use Gateway download/normalization limits. Raw sample bytes and message text are not stored. Message text is not automatically supplied to content rules: the explicit posting-context field and configured context gates still apply. Required Jev calls are charged normally; the existing exact-hash shortcut does not call Jev.


## Native text moderation (October 17, 2026)

Native text uses an exact domain-separated UTF-8 digest and no image rendering/reference comparison. Existing image fingerprints remain unchanged by the text switch. Text approvals bind modality, prompt/policy/model/thresholds; calibration cannot cross modalities. Default precedence adds native text after image content and before any-image. The same message user-action slot prevents duplicate sanctions across all modalities. See [text composition](TEXT_MODERATION.md).

## Portable reference policy

Reference/group/rule pack exports automatically close required image dependencies and embed exact asset bytes plus SHA-256 checksums. Compatible normalized JPEG exports are retained byte-for-byte after decoding and metadata/dimension validation; source assets and incompatible normalization builds use the existing normalization pipeline. Imported rules lose source approvals and begin disabled. Any-reference rules still mean all eligible destination references, including unrelated destination images; review that destination behavior before approval. Content-analysis rules remain independent of reference matching. See [format and compatibility](MODERATION_PACKS.md).
