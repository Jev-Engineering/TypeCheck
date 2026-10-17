# User-reviewed scam references

This collection contains 33 original images supplied by the project owner, who confirmed reviewing them as scams on 2026-10-17. The labels record that review; they are not model predictions or measured accuracy results.

- `images/` preserves the supplied files byte-for-byte.
- `manifest.json` records filenames, byte lengths, original-file SHA-256 hashes, and review status.
- `SHA256SUMS` lists checksums relative to this directory.

All 33 files matched the supplied `scams_SHA256SUMS.txt`. That source list also named 24 absent images; those entries are excluded because their images were not supplied. The source files remain unchanged.

New guilds receive these images automatically on their first authorized sign-in, in the `Starter scams (user-reviewed)` group. Both source deployments and Docker images include the collection. Initialization applies only to pristine guilds (settings revision 1, no images, groups, or rules), so existing configured guilds are left unchanged. Administrators can edit or delete the references normally; subsequent sign-ins do not restore deleted examples.

These hashes cover original file bytes. Initialization verifies the bundled originals, then generates the application's versioned normalized JPEG hashes using the installed decoder. The database import and settings revision advance occur in one guild transaction, preventing duplicate imports across concurrent sign-ins. A failed import can be retried. It creates no rules, calibration approvals, or enforcement settings. Administrators choose channels and configure and test rules through the normal flow. Existing guilds can explicitly preview/import the reference starter through Moderation packs or upload desired examples manually.

This collection is separate from the synthetic evaluation fixtures. It contains only user-labeled scam examples, with no legitimate negative examples or held-out evaluation split. The project's MIT license does not establish ownership or redistribution rights for these supplied images.

## Portable reference starter

The same original files are embedded byte-for-byte in the **Scam references** and **Combined scam setup** packs. Administrators can select them in Moderation packs and preview before import. Normalized digests adopt already present references; import/seed receipts track deletions. First-login seeding writes portable component tombstones. Legacy installations use their retained seed audit event; if that historical event is absent, missing legacy images cannot reliably be identified as previously deleted. No source image is renamed, relabeled as exclusively crypto-related or granted new redistribution rights. See [pack format and provenance](../../docs/MODERATION_PACKS.md).
