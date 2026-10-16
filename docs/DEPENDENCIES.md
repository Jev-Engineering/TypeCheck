# Dependency and image review

Reviewed October 15-16, 2026. `package-lock.json` is generated from the real registry resolution; CI and Docker use `npm ci`. No automatic `npm audit fix --force` was used.

## Application packages

Resolved direct versions: Discord Embedded App SDK 2.5.0; pg 8.23.1; sharp 0.35.5; TypeScript 5.9.3; esbuild 0.25.12; Node declarations 22.20.5. The high-severity native-image advisory on sharp 0.34.5 was fixed by explicitly upgrading sharp and rerunning native-decoder tests on Windows and Linux. `evidence/dependency-audit.json` records zero npm advisories at the time of this run, not a future guarantee.

The upgraded decoder rejected the previous 1-pixel PNG because its IDAT checksum was corrupt. Both the credential probe and test helper now use a valid encoded PNG. The corrupt input remains a rejection regression; strict decoding remains enabled.

## Licenses

`evidence/dependency-licenses.json` inventories all 86 lockfile package entries, including optional platform packages: MIT 52, Apache-2.0 15, LGPL-3.0-or-later 10, Apache-2.0 AND LGPL-3.0-or-later 3, ISC 3, Apache-2.0 AND LGPL-3.0-or-later AND MIT 1, Unlicense 1, 0BSD 1. `node scripts/review-dependencies.mjs` regenerates this inventory and fails on a new/unknown declaration pending review.

The sharp native distributions contain LGPL libraries, including libvips; they are not all permissively licensed merely because the sharp wrapper declares Apache-2.0. Preserve installed native package README/LICENSE files and review source/relinking/notice obligations before redistributing images or binaries. Native notices are retained with node_modules in the runtime image. This is an inventory review, not legal sign-off or an assertion that npm metadata enumerates every native component.

The browser SDK and bundled runtime dependencies (big-integer, decimal.js-light, eventemitter3, lodash.transform, uuid and zod) ship complete license files in `/vendor/THIRD_PARTY_NOTICES.txt`, generated during the build. The app remains private/UNLICENSED; dependency licenses do not change project ownership.

## Container review

The original Node 22 Bookworm runtime scan reported 4 critical and 60 high OS package findings plus 11 high npm-tool findings, although the application npm audit was clean. Most Node package findings came from `/usr/local/lib/node_modules/npm`, not application dependencies. See `evidence/container-vulnerabilities-initial.json`. These are scanner findings, not proven exploitable application paths; no suppression was used to manufacture a pass.

The runtime was updated to the official Node 22 Trixie slim image pinned at index digest `sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa`, applies current distro updates, and removes unused runtime npm/corepack/yarn. Build-stage npm remains available for locked installation/testing. Distro update resolution is time-dependent; the final image ID and scan must be retained for each release.

Docker Scout required unavailable Docker Hub authentication; a local Trivy scan of an exported image was used instead, with no Docker socket mount and no source upload. Final scanner output is `evidence/container-vulnerabilities.json`; its image metadata identifies the exact scanned build. Any residual high/critical findings remain a release-review gate and must be patched or assessed against official vendor advisories before production authorization. PostgreSQL image/host posture and independent review remain target-specific acceptance work.
