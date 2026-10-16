# Matching, calibration and costs

## Provider boundary

The adapter sends two normalized images per comparison through the official System One multipart protocol, using a Noul question and the explicit image header. It validates the model identifier, answer type, finite probability and usage fields. No free-form generated answer is parsed as an action. TypeSafe marks image support experimental; compatibility and accuracy can change [J1, J2].

`jev-1.14.0` is the default explicit model ID. Aliases are intentionally not accepted as a configuration substitute. A model change invalidates prior rule approval. The supported-model listing and image-specific documentation should both be checked when upgrading [J3].

The app uses its own private reference store. Jev is not treated as a persistent hosted image library. Comparisons are pairwise, with per-evaluation reuse for identical reference/mode combinations; no approximate candidate index silently excludes references. Each attachment has a 120-second evaluation deadline between calls, a guild daily request budget, and provider retry limits. A call already in flight can extend the elapsed time beyond that deadline.

## Modes and precedence

Exact asks whether the same visual image is present, not a different photograph of the same subject. Transformed permits configured classes of copy-like changes in the fixed prompt: resizing, compression, small crops, borders, overlays and minor color changes. Partial asks whether a copy appears within a composition; it does not produce a bounding box. Semantic is separately enabled and review-only.

Higher numeric rule priority wins. Ties favor individual-image, group, any-reference and then any-image rules, followed by stable rule ID. All comparisons are recorded; one effective user-level action is selected for a message. Message deletion can accompany that action. Selecting a less-severe/high-priority rule can intentionally suppress a lower-priority severe rule; severity does not silently override administrator priority.

A positive candidate must satisfy the greater of the rule threshold and action floor. An eligible but uncertain result is reviewed or ignored according to server settings. Provider errors never become positive results. An incomplete multi-image evaluation suppresses punitive dispatch for the whole message because rule precedence could otherwise be resolved incorrectly.

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

The fingerprint now includes the hash scheme and each eligible reference's content hash, object key, revision and hash version. This intentionally invalidates old approvals. Exact evidence is rejected if its binding no longer matches. New Jev evidence is also bound; legacy Jev records remain readable. Comparison reuse is confined to a single attachment evaluation and includes content/storage identity, revision/version, mode, model and verification pass; nothing persists across configuration changes. All required comparisons continue after a hash hit. A later provider failure retains partial evidence in the failed evaluation and suppresses whole-message execution.

Hash-only labeled tests store a deterministic prediction with null probability/model; they are excluded from Jev calibration counts, but any labeled hash false positive blocks approval. Administrators still need the existing positive/negative Jev calibration evidence (use representative non-identical normalized samples for the model path). Equality is matching evidence, not permission to punish. **Follow-up policy work:** any proposal for severe automatic actions based solely on hash evidence requires separately designed administrator approval/calibration/verification policy and acceptance; this PR does not authorize or implement that policy.

### Legacy references and backfill

Inspection found `sha256` computed over normalized JPEGs, but no persisted pipeline/native-codec version. Original uploads are not retained. Existing hashes therefore cannot safely be marked compatible. Re-normalizing retained lossy JPEGs is not equivalent to normalizing their original source. There is deliberately no backfill, migration or silent rewrite in this change: missing/incompatible versions use Jev. An authorized source re-upload through the existing revision-checked image API derives a fresh versioned hash; metadata-only edits preserve its existing version (or absence). PostgreSQL and MySQL already retain these fields in JSON records; no Store interface, index or schema change is needed.
