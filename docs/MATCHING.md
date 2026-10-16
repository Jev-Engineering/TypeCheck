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
