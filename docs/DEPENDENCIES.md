# Dependency and image review

## PR #8 runtime remediation — October 16, 2026

The Debian image's 43 high findings failed CI even after stable distro updates. The Docker build and runtime now use official `node:22-alpine3.24`, pinned at index digest `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`, with `apk upgrade --no-cache` in runtime. This removes the affected Debian package set instead of suppressing findings or mixing unstable Debian packages. Node remains 22.23.3. Build tools and runtime package-manager tools remain removed, and the runtime stays non-root.

[Official Node image documentation](https://github.com/nodejs/docker-node) describes Alpine's musl libc difference. [Sharp installation documentation](https://sharp.pixelplumbing.com/install/) supports prebuilt Linux musl binaries. Both Docker stages use the same Alpine base so npm selects the matching native binaries; do not copy Windows or glibc node_modules into this runtime. Native notices remain included. Other architectures still need their own validation.

Local linux/amd64 build passed all 164 tests, including native decoder tests. A read-only, network-disabled, non-root runtime smoke test decoded and re-encoded a synthetic image and loaded both PostgreSQL and MySQL clients. The unchanged CI high/critical scan and isolated Compose recovery drill remain required. Build and scan evidence use the `evidence/alpine-runtime-*` prefix. Historical Debian findings below describe the previous image, not this replacement. Distro updates and vulnerability databases are time-dependent; scans are not a guarantee of absence of vulnerabilities. Hosted GoDaddy processes outside Docker and remaining live/independent acceptance gates are unaffected.


Reviewed October 15-16, 2026. `package-lock.json` is generated from the real registry resolution; CI and Docker use `npm ci`. No automatic `npm audit fix --force` was used.

MySQL port review (October 16): mysql2 3.24.6 is an exact pin, loaded lazily through its promise API. Added driver/transitive declarations are MIT or Apache-2.0. The regenerated inventory contains 96 entries: MIT 61, Apache-2.0 16, LGPL-3.0-or-later 10, Apache-2.0 AND LGPL-3.0-or-later 3, ISC 3, Apache-2.0 AND LGPL-3.0-or-later AND MIT 1, Unlicense 1, 0BSD 1. The license check passed and npm audit reported zero advisories.

Reviewed [driver documentation](https://sidorares.github.io/node-mysql2/docs/documentation) and installed driver source for promise pools, JSON strings, affected-row flags and TLS. The adapter disables FOUND_ROWS and explicitly verifies TLS host identity. TypeScript 5.9.3, esbuild 0.25.12 and Node declarations 22.20.5 are now exact dependency pins because GoDaddy installs production packages before building. This increases the installed package surface; the earlier runtime image scan below does not cover the new graph. A fresh image scan is required before production acceptance. Earlier review details follow.

## Application packages

Pre-merge Docker follow-up: production-installed build tools are explicitly uninstalled after the Docker build/test stage so they are not copied into the final runtime. This removed 25 newly observed Go standard-library findings from esbuild. The corrected image scan has 0 critical / 43 high Debian findings and no Node-package findings, matching the existing OS release blocker. See `evidence/mysql-runtime-review.json`; the hosted GoDaddy environment is not covered by that Docker result.

Resolved direct versions: Discord Embedded App SDK 2.5.0; pg 8.23.1; sharp 0.35.5; TypeScript 5.9.3; esbuild 0.25.12; Node declarations 22.20.5. The high-severity native-image advisory on sharp 0.34.5 was fixed by explicitly upgrading sharp and rerunning native-decoder tests on Windows and Linux. `evidence/dependency-audit.json` records zero npm advisories at the time of this run, not a future guarantee.

The upgraded decoder rejected the previous 1-pixel PNG because its IDAT checksum was corrupt. Both the credential probe and test helper now use a valid encoded PNG. The corrupt input remains a rejection regression; strict decoding remains enabled.

## Licenses

`evidence/dependency-licenses.json` inventories all 86 lockfile package entries, including optional platform packages: MIT 52, Apache-2.0 15, LGPL-3.0-or-later 10, Apache-2.0 AND LGPL-3.0-or-later 3, ISC 3, Apache-2.0 AND LGPL-3.0-or-later AND MIT 1, Unlicense 1, 0BSD 1. `node scripts/review-dependencies.mjs` regenerates this inventory and fails on a new/unknown declaration pending review.

The sharp native distributions contain LGPL libraries, including libvips; they are not all permissively licensed merely because the sharp wrapper declares Apache-2.0. Preserve installed native package README/LICENSE files and review source/relinking/notice obligations before redistributing images or binaries. Native notices are retained with node_modules in the runtime image. This is an inventory review, not legal sign-off or an assertion that npm metadata enumerates every native component.

The browser SDK and bundled runtime dependencies (big-integer, decimal.js-light, eventemitter3, lodash.transform, uuid and zod) ship complete license files in `/vendor/THIRD_PARTY_NOTICES.txt`, generated during the build. The app itself is MIT-licensed (see [LICENSE](../LICENSE)); dependency licenses do not change project ownership.

## Container review

The original Node 22 Bookworm runtime scan reported 4 critical and 60 high OS package findings plus 11 high npm-tool findings, although the application npm audit was clean. Most Node package findings came from `/usr/local/lib/node_modules/npm`, not application dependencies. See `evidence/container-vulnerabilities-initial.json`. These are scanner findings, not proven exploitable application paths; no suppression was used to manufacture a pass.

The runtime was updated to the official Node 22 Trixie slim image pinned at index digest `sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa`, applies current distro updates, and removes unused runtime npm/corepack/yarn. Build-stage npm remains available for locked installation/testing. Distro update resolution is time-dependent; the final image ID and scan must be retained for each release.

Docker Scout required unavailable Docker Hub authentication; a local Trivy scan of an exported image was used instead, with no Docker socket mount and no source upload. Final scanner output is `evidence/container-vulnerabilities.json`; its image metadata identifies the exact scanned build. Any residual high/critical findings remain a release-review gate and must be patched or assessed against official vendor advisories before production authorization. PostgreSQL image/host posture and independent review remain target-specific acceptance work.

Final local scan: Debian 13.7, Node 22.23.3; **0 critical, 43 high, 58 medium, 60 low and 1 unknown OS package findings**, and zero Node-package findings. The 43 high entries represent 8 unique CVEs across packages, not 43 independent vulnerabilities. Image ID: `sha256:b153846e85277fc7dd4775dee73411c76216edd907ea9bc1356167e0f5534a4e`. Trivy image: `aquasec/trivy@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222`. Summary: `evidence/security-summary.json`.

The Debian tracker confirms the tested stable util-linux and ACL versions remain affected: [mount-helper issue](https://security-tracker.debian.org/tracker/CVE-2026-76642), [nsenter issue](https://security-tracker.debian.org/tracker/CVE-2026-78408), [ACL issue](https://security-tracker.debian.org/tracker/CVE-2026-54369). Non-root execution, dropped capabilities and no-new-privileges constrain these attack paths, but are mitigations rather than patches or independent sign-off. No arbitrary unstable packages were mixed into the stable image. **These findings are an unresolved release gate.** CI now scans the final runtime image and fails on high/critical findings; expect that gate to remain red until remediation or an explicitly reviewed policy change. Hosted CI has not been executed.
