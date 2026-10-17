# Self-contained starter packs

Import these JSON files through **Moderation packs → Pack file**, or select the same starters directly in the Activity. Preview first. Rules begin disabled, automatic enforcement off, with no destination approval.

- `reviewed-scam-references`: 33 owner-reviewed scam images and a reference group; no rules.
- `image-scam-analysis`: editable image-analysis definition and disabled review rule.
- `combined-scam-setup`: the same references, standalone definition, and separate reference/content review rules.
- `custom-template`: editable observable-policy definition and disabled review rule.

These are supplied templates and, for reference images only, human-reviewed examples. Software compatibility tests are separate evidence. No measured model accuracy or live deployment validation is claimed. The reference collection is not labeled exclusively crypto-specific. MIT code licensing does not establish redistribution rights for supplied images; retain [source provenance](../data/scams/README.md) and establish rights before redistribution.

Image bytes are embedded unchanged from `data/scams/images`; their manifest checksums are validated when samples are generated. The Activity builds packs using its installed normalization version, while these files record the build used to generate them. Other codec builds may show an explicit compatibility warning. Regenerate after compiling with `node scripts/build-starter-packs.mjs`. See [format, conflicts, mapping and complete-policy boundaries](../docs/MODERATION_PACKS.md).
