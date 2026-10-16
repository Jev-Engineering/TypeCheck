# Retheme the TypeCheck Activity to match typesafe.ai

You are working in `typecheck` (formerly `jev-image-guard`), a Discord image-moderation bot with an embedded management Activity. Restyle the Activity so it reads as a TypeSafe product, using https://typesafe.ai/ as the visual reference. This is a visual change only. Do not change behavior, routes, API calls, permissions, copy meaning, or data flow.

## Files in scope

- `activity/style.css` — the whole stylesheet (about 10.7 KB, minified-style single lines). Most of the work happens here.
- `activity/index.html` — the loading shell. It currently declares `color-scheme: dark`.
- `activity/src/main.ts` — DOM is built with `h(tag, attrs, ...children)`. Only touch markup where a new visual element needs a class or wrapper (for example, window title bars on panels). Keep class names stable where possible so the existing tests and `scripts/browser-smoke.py` still find things.
- `server/http.ts` — `staticFile()` (around line 401) serves a fixed map of paths, and the CSP (around line 422) is `default-src 'self'`, with no `font-src` and no third-party origins. Self-hosted fonts need new entries in that fixed map with correct `Content-Type` (`font/woff2`) and long-cache headers. Do not loosen the CSP to allow Google Fonts or any CDN, because Discord's Activity proxy would block them anyway.
- `scripts/preview.mjs` — the offline preview has its own `files` map. Add the same font paths so the preview renders identically.

## What typesafe.ai looks like (measured from the live site on 2026-10-15)

The site is a light, paper-and-ink editorial page with a retro 1-bit computer motif. It is the opposite of the Activity's current navy dark theme.

**Palette (exact computed values):**

| Token | Value | Use on the site |
|---|---|---|
| ink | `#1E1E1E` | headlines, window title bars, primary buttons ("Contact Us"), the most common background |
| ink-soft | `rgba(30,30,30,0.86)` | body copy |
| paper | `#FEFEFE` | page background, nav chips |
| pink | `#F386A1` | the brand color: full-bleed section backgrounds, skip-link, highlights |
| panel | `#DEDEDE` | retro window bodies |
| panel-shade | `#C4C4C4` | window bevels, secondary fills |
| magenta | `#E551BA` | rare accent (the docs site uses it more) |
| signal green | `rgba(3,170,92,0.74)` | the one status green |
| link blue | `#0000EE` | plain default links in the header, used on purpose as a raw-web touch |

The hero has a grainy pink-to-sky-blue cloud gradient behind the headline, and the pink section uses dense black halftone dot fields.

**Typography:**

- Display: *Die Grotesk C* (Medium 500 for headlines, Regular for body). Huge, tightly leaded headlines: 150px on 120px line height, 64px on 57.6px, normal letter-spacing, centered, ink color. Calm grotesk text, nothing condensed or decorative.
- Pixel/terminal: *LisaTerminal Paper*, a bitmap-style face used inside the retro windows, for title bars, labels, the clock, and table rows.
- Mono: *JetBrains Mono* for small metadata labels ("Not Chat", "[B.64]") and base64-looking decorative text.
- Inter appears in a few places.

**Motifs:**

- Retro "OS" windows: square corners (`border-radius: 0` everywhere), a 1px ink border, a solid ink title bar with small pixel-font white text (e.g. `Clock Tool 1.1`, `Glider 1.1`), grey `#DEDEDE` bodies, and highlighted labels shown as white-on-ink inverse chips.
- Nav items are small white chips with no radius, sitting on the image. The primary CTA is a solid ink chip with white text.
- Big text CTAs ("Create Account", "Join Discord") are just large grotesk words with a thick underline.
- Section labels are tiny mono text with a 1px left rule. Frames are marked with thin corner-crop marks.
- No soft shadows, no gradients on controls, no rounded cards.

## Licensing constraint on fonts

Die Grotesk C and LisaTerminal are commercial typefaces. **Do not download, copy, or embed them from typesafe.ai.** Use open-licensed stand-ins, self-hosted as `.woff2` under a new `activity/fonts/` directory, with each font's OFL license file next to it:

- Display/body grotesk: **Schibsted Grotesk** or **Inter Tight** (pick one; Medium 500 and Regular 400 only). Closest in feel to Die Grotesk.
- Pixel: **VT323** (already used for the TypeSafe look in the Jev-Engineering cookbook) or **Silkscreen** for very small caps labels.
- Mono: **JetBrains Mono** 400.

If the font files cannot be fetched in your environment, write the `@font-face` rules and server routes anyway, fall back to `ui-sans-serif` / `ui-monospace`, and list the exact files the operator must add. Never fabricate a font binary.

## Design direction for the Activity

Translate the site's look into a dense admin tool. Do not copy the marketing page's scale. The Activity runs inside a Discord iframe that is often 800 to 1100px wide and sometimes phone-sized.

1. **Tokens first.** Replace the `:root` block with named tokens: `--ink`, `--ink-soft`, `--paper`, `--pink`, `--panel`, `--panel-shade`, `--magenta`, `--ok`, `--warn`, `--bad`, `--line` (= ink), `--focus`, plus `--font-display`, `--font-pixel`, `--font-mono`. Every color in the stylesheet must come from a token. Derive `--warn` and `--bad` in the same flat style (for example a mustard `#D9A400` and a brick `#C8372D`) and check that their text pairings meet WCAG AA.
2. **Light theme by default, with a real dark variant.** Discord's client is usually dark, so ship both. Light is paper/ink/pink. Dark is ink background (`#1E1E1E`), paper text, panel surfaces at about `#2A2A2A`, and pink kept as the accent. Use `@media (prefers-color-scheme: dark)` guarded so it can be overridden, and update `color-scheme` in `index.html` to `light dark`. Both themes must keep the square-window identity.
3. **Shell.** The sidebar becomes an ink column with paper text. The active nav item is an inverse chip (paper on ink in light theme, pink on ink is also acceptable). The brand mark "J" becomes a square pink tile with an ink pixel-font letter, with no radius. The top bar sits on paper with a 1px ink bottom rule. "MONITOR ONLY" / "ENFORCEMENT ON" become pixel-font status chips.
4. **Page headings.** The `h1` uses the display font at 500 weight, around 44–56px on desktop with line-height about 0.9 and slightly negative tracking, scaling down on mobile. The eyebrow ("CONTROL PANEL", "DISCORD ACTIVITY") becomes tiny mono text with the 1px left rule from the site.
5. **Panels become retro windows.** Every `section`/card/panel gets a 1px ink border, no radius, and no shadow. A title strip carries the panel's heading in the pixel font, white on ink, like `Setup checklist`, `Usage & safeguards`, `Reference library`. Bodies are `--panel` grey in light theme. If this needs a wrapper element, add it through one helper in `main.ts`, not by hand in every view.
6. **Overview hero.** Replace the navy gradient hero with a pink block (`--pink`) carrying a subtle CSS-only halftone dot pattern (`radial-gradient` dots, low contrast, no images). "Match an image. Apply your policy." goes in the display font in ink. The BOT OFFLINE / JEV MISSING chips become small pixel-font windows or inverse chips.
7. **Stat tiles** (3 / 3 / 0 / 0): large display-font numerals, mono labels, and square tiles with ink borders.
8. **Buttons.** Primary is solid ink with paper text, square, and hovers to pink with ink text. Quiet is paper with a 1px ink border. Danger is paper with a brick border and brick text, filling brick on hover. Keep visible `:focus-visible` outlines (2px, offset, `--magenta` or pink, whichever passes contrast on each background).
9. **Badges/chips.** Square, pixel or mono font, uppercase. DONE/ACTIVE use green, NEXT/neutral use inverse ink, REQUIRED/amber use mustard, red uses brick. Do not use colored pastel pills.
10. **Tables** (rules, activity log, events): mono or pixel font for IDs, timestamps and numbers; grotesk for names; 1px ink row rules; and the ink-on-highlight label treatment for rule names, like the site's model comparison table.
11. **Forms.** Square inputs with 1px ink borders on paper, a pixel-font label above each, checkboxes as square ink-bordered boxes with an ink check, and channel/role pick lists as small window panes.
12. **Offline preview banner.** Keep it prominent. Style it like the site's `Oct 9, 2026 • TypeSafe News` box: an ink title strip in the pixel font, a grey body, and centered mono text.
13. **Dialogs** (Create rule, confirmations): retro windows with a title bar and a square ✕ close control.
14. **Restraint.** No grain or cloud gradients behind dense data. The halftone appears only in the Overview hero and optionally the login page. The login page (`main.login` in `index.html` and the connected start screen) may borrow the site's grainy pink/sky gradient and a large display headline, built in pure CSS.

## Constraints

- No new runtime dependencies, no framework, no CSS preprocessor, no external requests at runtime.
- Keep the stylesheet hand-written and tokenized. Keeping one line per rule group is fine, but readability is preferred over the current minification.
- Respect `prefers-reduced-motion` (no new animations are needed at all).
- Mobile (≤ 640px): the sidebar collapses as it does today, there is no horizontal overflow, and minimum hit targets are 40px.
- Do not alter text content except where a label is moved into a window title bar.
- Do not change any `server/` logic other than adding the font routes.

## Verification you must run and report honestly

1. `npm run check` and `npm test` pass (or report exact failures). If packages are not installed, say so instead of claiming a pass.
2. `npm run compile && npm run preview`, then open http://127.0.0.1:4173 and click through every screen: login, Overview, Image library, Rules & tests, Activity log, Permissions, Settings, and the Create rule dialog. Do this at 1280×840 and 390×844, in both light and dark color schemes.
3. Run `scripts/browser-smoke.py` if Playwright is available. All 14 checks must still pass with no horizontal overflow.
4. Replace `evidence/preview-desktop.png`, `preview-library.png`, and `preview-mobile.png` with fresh screenshots, keeping the "offline preview" labeling.
5. Check contrast for every text/background token pair you introduce, and list them with their ratios.
6. Regenerate `SHA256SUMS` for every file you changed or added (the repo ships a checksum manifest).

## Deliverable

A short report covering: files changed, fonts chosen and their licenses, a before/after description per screen, the contrast table, test and smoke output, and anything you could not verify. Do not commit, push, or deploy unless the operator asks.
