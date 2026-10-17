# Synthetic native text evaluation candidates

`dataset.json` contains 70 labeled synthetic candidates: 30 tuning and 40 separate held-out variants across ten families. Labels describe intended examples, not measured performance or production truth. Promotion/conduct/custom cases stay ambiguous until concretely configured. Quotations, warnings, lookalikes and injection attempts are included. These samples are unrelated to the 33 user-reviewed scam images.

Run `node scripts/validate-text-dataset.mjs` after build. Before paid evaluation, freeze a commit, configure policies, independently adjudicate labels and authorize the provider budget. Tune on `tuning` only; keep `held_out` blind until policy/model/threshold are frozen. Templated held-out variants are not an independent naturalistic dataset. Real community/language coverage needs a privacy-reviewed authorized process.

For authorized provider runs, test each case through the text rule test API, never enforcement. Record commit, dataset hash, policy fingerprint, pinned model, thresholds and request/usage IDs. Report ambiguous labels separately, abstention coverage and confusion counts. Never equate probabilities with accuracy or relabel after seeing held-out results. Manifest validation and unit tests make no paid calls.
