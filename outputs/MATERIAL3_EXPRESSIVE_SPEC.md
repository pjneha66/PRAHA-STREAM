# PRAHA STREAM — Material 3 Expressive Design Spec

**Version:** 1.0 · **Scope:** Design spec + preview / Shell + Home redesign / Full UI overhaul  
**Target:** React 19 + TypeScript + Vite 7 + Capacitor 8 · Android TV + mobile + desktop web  
**Baseline:** v2.5.4 · `index.css` (2,781 lines), `Navigation.tsx` (299), `HomeView.tsx` (246)  
**Companion preview:** `outputs/m3-expressive-preview.html` (standalone, no dependencies)

---

## 1. Design intent

Material 3 Expressive is the *expressive* branch of M3: larger corner radii, bolder type,
tonal colour containers, spring-based motion, and pill-shaped active indicators. For a
10-foot TV UI it also happens to be the right accessibility default — big shapes and
high-contrast focus states are easier to resolve from a couch.

Three non-negotiable constraints shaped every decision:

1. **Do not rewrite 2,781 lines of CSS.** The app already has a variable token layer
   (`:root` → `--bg`, `--surface*`, `--accent`, `--text`, `--muted`, `--line`,
   `--focus-ring`). The redesign introduces a full `--md-sys-*` role system and
   **re-maps the legacy variables onto it**. Every existing rule inherits the new
   system. That is what turns a two-screen mockup into a genuine full UI overhaul.
2. **Preserve all five accent themes.** `gold`, `jade`, `rosegold`, `arcticblue`,
   `graphite` are user-selectable and must survive. Each maps its accent onto
   `--md-sys-color-primary` / `on-primary` / `primary-container` rather than
   hardcoding `--accent`.
3. **Preserve every test-visible string.** `tests/app.integration.test.tsx` asserts
   on "Who's watching?", nav labels, and tab names. No copy changes.

---

## 2. Colour system

### 2.1 Dark (default) — "Gold" reference palette

| Role | Token | Value | Use |
|---|---|---|---|
| Primary | `--md-sys-color-primary` | `#FFD45C` | CTAs, active indicator, focus ring |
| On primary | `--md-sys-color-on-primary` | `#181305` | Text on primary |
| Primary container | `--md-sys-color-primary-container` | `#4A3800` | Tonal filled buttons, selected chips |
| On primary container | `--md-sys-color-on-primary-container` | `#FFE49B` | Text on container |
| Secondary | `--md-sys-color-secondary` | `#85BFFA` | Supporting actions |
| Tertiary | `--md-sys-color-tertiary` | `#B7A1FA` | Accents, badges |
| Error | `--md-sys-color-error` | `#FFB4AB` | Destructive / blocked states |
| Surface | `--md-sys-color-surface` | `#17150F` | Page background |
| Surface lowest | `--md-sys-color-surface-container-lowest` | `#100E09` | Deep wells, player |
| Surface low | `--md-sys-color-surface-container-low` | `#1D1A13` | Sidebar, cards |
| Surface | `--md-sys-color-surface-container` | `#221E16` | Cards, sheets |
| Surface high | `--md-sys-color-surface-container-high` | `#2C271D` | Hover / elevated |
| Surface highest | `--md-sys-color-surface-container-highest` | `#383224` | Menus, popovers |
| On surface | `--md-sys-color-on-surface` | `#F5F0E4` | Primary text |
| On surface variant | `--md-sys-color-on-surface-variant` | `#C9C2B0` | Secondary text |
| Outline | `--md-sys-color-outline` | `#6B6555` | Borders |
| Outline variant | `--md-sys-color-outline-variant` | `#3A352A` | Dividers |
| Inverse surface | `--md-sys-color-inverse-surface` | `#F5F0E4` | Snackbars / tooltips |

### 2.2 Light theme

`:root[data-theme='light']` plus a guarded `@media (prefers-color-scheme: light)`.
Light primary is darkened to `#7A5C00` to keep ≥4.5:1 contrast against
`#FEF8EC` surfaces; `--md-sys-color-primary-container` becomes `#FFE49B`.
`color-scheme` is set to `light dark` / `light` accordingly. The existing dark
default is **never silently overridden** — an explicit theme attribute wins.

### 2.3 Accent theme mapping

| Theme | primary | on-primary | primary-container |
|---|---|---|---|
| gold | `#FFD45C` | `#181305` | `#4A3800` |
| jade | `#7BF08D` | `#07190F` | `#14562B` |
| rosegold | `#FFB37A` | `#1F0D15` | `#5C2338` |
| arcticblue | `#4DE3FF` | `#081724` | `#0B4356` |
| graphite | `#F3F5F7` | `#111215` | `#3A4149` |

Legacy aliases (`--accent`, `--accent-rgb`, `--accent-ink`, `--focus-ring`,
`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--text`, `--muted`, `--line`)
are defined **in terms of** these roles, so all 2,781 existing rules upgrade at once.

---

## 3. Shape

| Token | Value | Applied to |
|---|---|---|
| `corner-none` | `0` | Full-bleed dividers |
| `corner-extra-small` | `4px` | Badges, micro-labels |
| `corner-small` | `8px` | Chips, small inputs |
| `corner-medium` | `12px` | Buttons, inputs |
| `corner-large` | `16px` | Cards, sheets |
| `corner-extra-large` | `28px` | Hero, featured cards, dialogs |
| `corner-full` | `999px` | Nav active indicator, pills, FAB |

Expressive signature: **28px hero/cards, full-radius active indicator**, replacing the
legacy 10–11px buttons and 24px hero.

---

## 4. Typography

Manrope Variable (already bundled via `@fontsource-variable/manrope`). Expressive
uses a bolder, tighter display scale:

| Scale | Size / line / weight / tracking | Use |
|---|---|---|
| Display L | 57 / 64 / 800 / −0.02em | Hero title |
| Display M | 45 / 52 / 800 / −0.01em | Who's watching gate |
| Headline L | 32 / 40 / 750 / 0 | Section headers |
| Headline M | 28 / 36 / 700 / 0 | Card titles |
| Title L | 22 / 28 / 700 / 0 | Row titles |
| Title M | 16 / 24 / 650 / +0.01em | Nav, buttons |
| Body L | 16 / 24 / 500 | Descriptions |
| Body M | 14 / 20 / 500 | Secondary copy |
| Label L | 14 / 20 / 700 / +0.02em | Buttons, chips |
| Label M | 11 / 16 / 750 / +0.06em | Overlines, badges |

Minimum on-screen body size for TV is 14px at 1080p; legacy 9–11px micro-labels
are raised where they carry meaning.

---

## 5. Motion

| Token | Value |
|---|---|
| `--md-sys-motion-easing-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--md-sys-motion-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| `--md-sys-motion-duration-short` | `180ms` |
| `--md-sys-motion-duration-medium` | `320ms` |
| `--md-sys-motion-duration-long` | `520ms` |

Focus/hover uses spring; page/hero entrance uses emphasized. All motion is disabled
under `@media (prefers-reduced-motion: reduce)` — including the existing
`hero-in` animation.

---

## 6. Elevation & spacing

`--md-sys-elevation-level0..5` map to progressively stronger tonal lifts plus
soft shadows. Expressive prefers **tonal elevation** (lighter surface container)
over heavy drop shadows on dark themes.

Spacing is an 8dp grid with a 4dp half-step:

`--md-space-1: 4px` · `2: 8px` · `3: 12px` · `4: 16px` · `5: 24px` ·
`6: 32px` · `7: 48px` · `8: 64px`

Shell grid: `240px minmax(0, 1fr)` (raised from `218px` to accommodate 48dp
targets and the pill indicator). All shell/Home gaps and padding snap to the scale.

---

## 7. Component specs

### 7.1 Navigation shell (`Navigation.tsx`)

- **Active indicator:** full-radius pill in `primary-container` with
  `on-primary-container` text and `aria-current="page"`. Replaces the legacy
  subtle background wash.
- **Targets:** every `.nav-item` ≥48px min-height, ≥48px min-width for icon-only
  variants; 8dp grid spacing; spring easing on hover/press.
- **Overlays (TV accessibility fix):** profile popover and mobile "More" sheet
  become `role="dialog" aria-modal="true"` with an `aria-label`. On open, focus
  the first focusable button; scope arrow-key focus inside the overlay; close on
  Escape; restore focus to the trigger on close. This makes the existing
  `useSpatialNavigation.ts` overlay scoping actually engage — previously the
  popover was only `role="menu"` and the sheet had no dialog semantics, so D-pad
  focus could escape behind the overlay.
- Preserve nav item id/order and all visible labels verbatim.

### 7.2 Home (`HomeView.tsx`)

- **Hero:** Display L title, gradient scrim, 28px corners, tonal primary CTA +
  outlined secondary CTA, both ≥48px.
- **Section headers:** Headline L / Title L with `--md-space-*` spacing and an
  overline Label M.
- **Cards:** `corner-extra-large`, `surface-container` tonal fill, elevation
  level1 on hover/focus, emphasized motion on entrance.
- **Rows:** 8dp gutters, `scroll-snap-type: x proximity` for D-pad stepping.
- Data flow (`MediaRow`, `JellyfinHome`, `AddonHomeRows`, `sourceBanner`, hero
  state) remains untouched.

### 7.3 Global controls

All `.button`, `.button-small`, `.filter-pills button`, `.quality-filters button`,
tabs, chips, inputs and selects are raised to **≥48px** min-height. Legacy values
were: `.nav-item` 45px (`index.css:225`), `.button` 41px (`:265`),
`.button-small` 33px (`:274`), filter pills 32px (`:370`), hero actions 43px
(`:295`) — all below the M3 / Android TV 48dp minimum.

**Focus ring:** consistent 3px `--focus-ring` `:focus-visible` outline with a 2px
offset, visible against every surface container. This is the primary TV affordance.

---

## 8. Defect fixed as part of the overhaul

`.details-episode-card` base rule (~`index.css:2022`) sits **after** earlier
`@media (max-width:680px)` blocks. With equal specificity the later base rule wins
and the mobile declarations are silently discarded. Fix: move the base rule before
the media queries (or scope the mobile rules with higher specificity). Verified by
comparing computed styles at 375px and 1280px.

---

## 9. Accessibility acceptance criteria

- [ ] Every interactive element ≥48×48 CSS px.
- [ ] `:focus-visible` ring visible on all focusable elements, 3px, ≥3:1 contrast.
- [ ] All overlays are `role="dialog" aria-modal="true"`, trap arrow-key focus,
      close on Escape, restore trigger focus.
- [ ] All icon-only buttons have `aria-label`.
- [ ] Light theme passes ≥4.5:1 for body text and ≥3:1 for large text.
- [ ] `prefers-reduced-motion` disables all transitions/animations.
- [ ] D-pad arrow navigation never scrolls the underlying page (fixed separately
      in `hooks/useSpatialNavigation.ts`).
- [ ] All five accent themes render correctly in both dark and light.
- [ ] No test-visible strings changed; `npm test` stays green.

---

## 10. Migration strategy

1. Insert the `--md-sys-*` token block after the `@import` in `index.css`.
2. Rewrite `:root` legacy aliases as references to the new roles.
3. Rewrite each `[data-theme=...]` block to set primary/container roles.
4. Add light theme + reduced-motion + focus-visible global rules.
5. Override target sizes with a single consolidated block near the top so it wins
   over the many scattered component rules.
6. Relocate `.details-episode-card` base rule.
7. Apply JSX changes to `Navigation.tsx` and `HomeView.tsx`.
8. Verify `npm run typecheck && npm test && npm run build` and
   `./gradlew assembleDebug`.

**Residual risk:** the CSS is dense and hand-written; a token remap can shift contrast
on a handful of hard-coded `rgba()` and hex values that bypass variables. The
preview file includes a "Compare legacy" toggle to eyeball the delta, and a
follow-up pass should audit literal colours that remain outside the token system.
