# .inc design system: Graphite

Engineer-facing guide for the renderer UI. Source of truth for values is `src/renderer/styles/tokens.css`; Monaco mirrors it in `src/renderer/monaco/themes.ts`; measured contrast lives in `docs/contrast-report.md`.

## 1. Principles

1. **Quiet.** No gradients, glass, glow, neon, emoji, illustrations or large shadows. If an element does not carry information, remove it.
2. **Precise.** 4px grid, 1px hairlines, radii of 2, 4 and 6px, 16px line icons at 1.5px stroke.
3. **Restrained colour.** Neutral cool-slate surfaces, one cobalt accent. Semantic colours mean status and nothing else. Git colours are muted.
4. **Legible.** WCAG 2.2 AA everywhere: 4.5:1 text, 3:1 for UI boundaries, icons and focus rings. High-contrast themes reach 7:1. No pure black or white editor background in the default themes.
5. **Familiar, but flatter.** Activity bar, sidebar, tabs, bottom panel, status bar. Structure comes from hairlines and small tonal steps, not from boxes and shadows.
6. **Plain copy.** Sentence case, no exclamation marks, no jargon.

Themes: `light` (default), `dark`, `hc-light`, `hc-dark`. Set `document.documentElement.dataset.theme`. Light and dark are equal citizens: design and review both.

## 2. Using tokens

- Components use custom properties only. No raw hex, `rgb()` or one-off pixel values for colour, radius, space or motion.
- Translucent fills (`--state-*`, `--editor-selection`) are designed for the surface of their region. Do not stack them on unrelated surfaces.
- Add a token only when an existing one cannot express the role. Put new tokens in the "Extended tokens" section of each theme block and add a contrast check.
- Monaco cannot read CSS variables. Update `themes.ts` in the same change as `tokens.css`.
- Extended (non-contract) tokens: `--icon-size`, `--icon-stroke`, `--scrollbar-size`, `--focus-ring-width`, `--focus-ring-offset`, `--scrollbar-thumb*`, `--scrollbar-track`, `--diff-added-bg`, `--diff-removed-bg`, `--minimap-slider`, `--toggle-off`.
- Two local aliases are used by layout CSS: `--divider` (`--border-subtle`, or `--border-strong` in high contrast) and `--float-border` (same rule) for floating surfaces.

## 3. Token reference

Values below are the light and dark themes. High-contrast values are in `tokens.css`.


**Surfaces**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--surface-app` | Window backdrop, visible only between regions | `#dde2e8` | `#0e1114` |
| `--surface-titlebar` | Title bar, tab strip background | `#e9ecf0` | `#121519` |
| `--surface-activitybar` | Activity bar | `#e9ecf0` | `#121519` |
| `--surface-sidebar` | Sidebar views | `#f1f3f6` | `#171b20` |
| `--surface-editor` | Editor, welcome, settings | `#f8f9fb` | `#1b2026` |
| `--surface-panel` | Bottom panel | `#f8f9fb` | `#1b2026` |
| `--surface-statusbar` | Status bar | `#e9ecf0` | `#121519` |
| `--surface-raised` | Menus, palette, dialogs, toasts | `#ffffff` | `#232a32` |
| `--surface-input` | Text inputs, selects | `#ffffff` | `#12161a` |
| `--surface-scrim` | Behind modal dialogs | `rgba(20, 28, 40, 0.38)` | `rgba(6, 8, 11, 0.62)` |

**States**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--state-hover` | Pointer over a row or control | `rgba(27, 35, 48, 0.055)` | `rgba(255, 255, 255, 0.05)` |
| `--state-active` | Pressed | `rgba(27, 35, 48, 0.1)` | `rgba(255, 255, 255, 0.09)` |
| `--state-selected` | Selected, container not focused | `rgba(27, 35, 48, 0.09)` | `rgba(148, 163, 184, 0.16)` |
| `--state-selected-focus` | Selected, container focused | `rgba(31, 95, 209, 0.14)` | `rgba(76, 141, 255, 0.24)` |

**Borders**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--border-subtle` | Structural hairlines (decorative) | `#dbe0e6` | `#272e36` |
| `--border-default` | Input, button, toggle edges (3:1) | `#788393` | `#6b7583` |
| `--border-strong` | Hover edge, HC dividers, emphasis | `#525d6e` | `#8994a3` |
| `--border-focus` | Focus ring (3:1) | `#1f5fd1` | `#6aa3ff` |

**Text**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--text-primary` | Body, labels, values | `#1b2330` | `#e6eaf0` |
| `--text-secondary` | Supporting text, inactive tabs, status bar | `#445062` | `#aab4c1` |
| `--text-tertiary` | Hints, placeholders, group headers | `#5a6677` | `#8b96a5` |
| `--text-inverse` | On toast-style inverse fills and danger fills | `#f8f9fb` | `#12161a` |
| `--text-link` | Links and matched characters | `#1a56c0` | `#7fb0ff` |
| `--text-on-accent` | Text on accent fills | `#ffffff` | `#0a111c` |

**Accent**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--accent` | Primary fill, active indicators, toggle on | `#1f5fd1` | `#4c8dff` |
| `--accent-hover` | Primary hover | `#184fb3` | `#6aa3ff` |
| `--accent-active` | Primary pressed | `#124095` | `#3d7ae6` |
| `--accent-subtle` | Tinted accent backgrounds | `#e2ebfb` | `#1b2e4f` |

**Status**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--status-error` | Errors, destructive | `#b3261e` | `#f28083` |
| `--status-warning` | Warnings, Restricted Mode | `#8a5a00` | `#e0b45a` |
| `--status-info` | Information | `#1a5bb8` | `#7db4f2` |
| `--status-success` | Success | `#1b7a43` | `#5ec08c` |
| `--status-error-bg` | Error banner tint | `#fbe8e7` | `#3b2226` |
| `--status-warning-bg` | Warning banner tint | `#fbf0d9` | `#392f1c` |
| `--status-info-bg` | Info banner tint | `#e3edfb` | `#1b2d45` |
| `--status-success-bg` | Success banner tint | `#e1f3e8` | `#1c3527` |

**Git**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--git-added` | Added (A) | `#23703f` | `#74b98b` |
| `--git-modified` | Modified (M), also gutter | `#7d5c0e` | `#cbaa6a` |
| `--git-deleted` | Deleted (D) | `#ab3b3d` | `#d48586` |
| `--git-untracked` | Untracked (U) | `#196d62` | `#62b5a5` |
| `--git-conflict` | Merge conflict | `#9d491d` | `#dc8b5d` |
| `--git-ignored` | Ignored files | `#59626f` | `#929ba8` |

**Editor**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--editor-line-highlight` |  | `rgba(27, 35, 48, 0.045)` | `rgba(255, 255, 255, 0.04)` |
| `--editor-selection` |  | `rgba(31, 95, 209, 0.2)` | `rgba(76, 141, 255, 0.2)` |
| `--editor-selection-inactive` |  | `rgba(27, 35, 48, 0.1)` | `rgba(255, 255, 255, 0.1)` |
| `--editor-cursor` |  | `#1b2330` | `#e6eaf0` |
| `--editor-gutter-fg` |  | `#66727f` | `#7f8b9b` |
| `--editor-gutter-fg-active` |  | `#1b2330` | `#d0d6de` |
| `--editor-indent-guide` |  | `rgba(27, 35, 48, 0.1)` | `rgba(255, 255, 255, 0.08)` |
| `--editor-indent-guide-active` |  | `rgba(27, 35, 48, 0.3)` | `rgba(255, 255, 255, 0.24)` |
| `--editor-find-match` |  | `rgba(214, 150, 20, 0.34)` | `rgba(224, 176, 84, 0.36)` |
| `--editor-bracket-match` |  | `rgba(31, 95, 209, 0.2)` | `rgba(76, 141, 255, 0.3)` |

**Syntax**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--syntax-comment` |  | `#535f6d` | `#94a1b0` |
| `--syntax-keyword` |  | `#1f4fc0` | `#8fb0f5` |
| `--syntax-string` |  | `#1a6c3f` | `#8dc9a3` |
| `--syntax-number` |  | `#8f4d0f` | `#d9a877` |
| `--syntax-function` |  | `#0b667d` | `#7fc4d6` |
| `--syntax-type` |  | `#6a44b0` | `#b8a4e3` |
| `--syntax-variable` |  | `#263041` | `#d5dbe3` |
| `--syntax-constant` |  | `#a0401d` | `#e3a98c` |
| `--syntax-operator` |  | `#465264` | `#aab4c1` |
| `--syntax-punctuation` |  | `#535f70` | `#9aa5b3` |
| `--syntax-tag` |  | `#1a5bb8` | `#79b0f2` |
| `--syntax-attribute` |  | `#81550a` | `#d8b878` |

**Terminal**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--terminal-bg` |  | `#f8f9fb` | `#1b2026` |
| `--terminal-fg` |  | `#263041` | `#d0d6de` |
| `--terminal-cursor` |  | `#1b2330` | `#e6eaf0` |
| `--terminal-selection` |  | `rgba(31, 95, 209, 0.2)` | `rgba(76, 141, 255, 0.2)` |
| `--ansi-black` |  | `#263041` | `#38414b` |
| `--ansi-red` |  | `#b3261e` | `#f0787c` |
| `--ansi-green` |  | `#1b7042` | `#7fc79a` |
| `--ansi-yellow` |  | `#85600a` | `#e0b865` |
| `--ansi-blue` |  | `#1f55c4` | `#6fa5f5` |
| `--ansi-magenta` |  | `#8a3fb0` | `#c39ae8` |
| `--ansi-cyan` |  | `#0b6a82` | `#63c3d3` |
| `--ansi-white` |  | `#5b6677` | `#c8cfd8` |
| `--ansi-bright-black` |  | `#566173` | `#8792a1` |
| `--ansi-bright-red` |  | `#c23a33` | `#ff9a9e` |
| `--ansi-bright-green` |  | `#237a4b` | `#9bddb2` |
| `--ansi-bright-yellow` |  | `#96690a` | `#f2ce85` |
| `--ansi-bright-blue` |  | `#2f63d6` | `#92bdff` |
| `--ansi-bright-magenta` |  | `#9a4cc2` | `#d9b8f5` |
| `--ansi-bright-cyan` |  | `#14778f` | `#86d9e6` |
| `--ansi-bright-white` |  | `#3d4858` | `#f0f3f7` |

**Extended**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--scrollbar-thumb` | Scrollbar thumb, rest | `rgba(27, 35, 48, 0.5)` | `rgba(255, 255, 255, 0.36)` |
| `--scrollbar-thumb-hover` | Thumb hover | `rgba(27, 35, 48, 0.62)` | `rgba(255, 255, 255, 0.5)` |
| `--scrollbar-thumb-active` | Thumb dragging | `rgba(27, 35, 48, 0.76)` | `rgba(255, 255, 255, 0.66)` |
| `--scrollbar-track` | Track (transparent) | `transparent` | `transparent` |
| `--diff-added-bg` | Diff inserted text | `rgba(35, 112, 63, 0.12)` | `rgba(116, 185, 139, 0.14)` |
| `--diff-removed-bg` | Diff removed text | `rgba(171, 59, 61, 0.12)` | `rgba(212, 133, 134, 0.14)` |
| `--minimap-slider` | Minimap viewport shade | `rgba(27, 35, 48, 0.1)` | `rgba(255, 255, 255, 0.1)` |
| `--toggle-off` | Toggle track and knob, off | `#788393` | `#66717f` |
| `--shadow-raised` | Menus, toasts, palette | `0 1px 2px rgba(20, 28, 40, 0.1), 0 2px 6px rgba(20, 28, 40, 0.08)` | `0 1px 2px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.24)` |
| `--shadow-modal` | Dialogs | `0 4px 16px rgba(20, 28, 40, 0.16), 0 1px 3px rgba(20, 28, 40, 0.12)` | `0 4px 16px rgba(0, 0, 0, 0.44), 0 1px 3px rgba(0, 0, 0, 0.32)` |


## 4. Metrics

| Metric | Token | Value |
|---|---|---|
| Title bar | `--titlebar-height` | 36px |
| Activity bar | `--activitybar-width` | 48px (button 48 x 44) |
| Sidebar | `--sidebar-width` | 264px |
| Tab strip | `--tab-height` | 36px |
| Breadcrumb | `--breadcrumb-height` | 24px |
| Panel header | `--panel-header-height` | 32px |
| Status bar | `--statusbar-height` | 24px |
| List, tree and menu row | `--row-height` | 24px |
| Editor line | `--editor-line-height` | 20px |
| Control height | none | 28px (24px compact) |

## 5. Type, space, shape, elevation, motion

**Type.** UI font `--font-ui`: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif. Editor and terminal font `--font-mono`: "Cascadia Code", "SF Mono", Consolas, Menlo, monospace, 13px, line height 20px, ligatures off by default. Never load web fonts.

| Token | Size | Use |
|---|---|---|
| `--font-size-xs` | 11px | Keybinding chips, group headers, counts, git letters |
| `--font-size-sm` | 12px | Status bar, breadcrumb, descriptions, panel tabs |
| `--font-size-md` | 13px | Default UI and editor |
| `--font-size-lg` | 15px | Dialog titles only |

Weights: `--font-weight-regular` 400, `--font-weight-medium` 500 (buttons, active nav), `--font-weight-semibold` 600 (titles, matched characters, wordmark). `--line-height-ui` is 20px.

**Space.** `--space-1..8` = 4, 8, 12, 16, 20, 24, 32, 40px. Nothing else. Gaps between related controls use `--space-2`; between groups `--space-4` or `--space-6`.

**Radius.** `--radius-sm` 2px for controls (buttons, inputs, tabs, badges, rows, chips); `--radius-md` 4px for floating surfaces (menus, palette, toasts); `--radius-lg` 6px for modal dialogs only. Nothing rounder, except the 6px activity badge.

**Elevation.** Surfaces are flat; hairlines separate them. `--shadow-raised` (menus, palette, toasts) and `--shadow-modal` (dialogs) are the only shadows. Floating surfaces also carry a 1px `--border-subtle` border (`--border-strong` in high contrast, where shadows are `none`).

**Motion.** `--motion-fast` 80ms (hover, press), `--motion-base` 140ms (toggle, popups), easing `--ease-standard`. Animate colour, opacity and transform only. No bounce, no slide-in over 8px, no looping animation. Both durations become 0ms under `prefers-reduced-motion: reduce`, so all motion must be written with the tokens.

## 6. Iconography

- Library: `lucide-react`. Render at `size={16}` and `strokeWidth={1.5}` with `absoluteStrokeWidth`. Round caps and joins.
- Icons take `currentColor`. Default `--text-secondary`; hover and active `--text-primary`; disabled `--text-tertiary`.
- Icons never carry meaning alone: give icon-only buttons an `aria-label` and a tooltip.
- Status icons (error, warning, info) use the matching `--status-*` colour. Never use filled or duotone icons, emoji, or icons with gradients.
- Icon-only hit targets are 24 x 24 (toolbar) or 48 x 44 (activity bar) around the 16px glyph.

Brand assets: `resources/brand/icon.svg` (app icon, 512 viewBox, shapes only) and `resources/brand/wordmark.svg` (".inc" as paths, `currentColor` letters, brand-blue dot `#3574f0`, 3.8:1 or better on the light and dark editor surfaces). In the title bar the wordmark is set in `--font-mono` semibold with a 5px `--accent` dot.

## 7. Focus ring

One rule for everything interactive: `:focus-visible { outline: var(--focus-ring-width) solid var(--border-focus); outline-offset: var(--focus-ring-offset); }`.

- Width 2px (`--focus-ring-width`). Offset 1px (`--focus-ring-offset`), 2px in high contrast.
- Inside bordered fields (inputs, selects, palette field) use `outline-offset: -1px` so the ring overlaps the border.
- Never remove an outline without replacing it. Mouse clicks do not show the ring (`:focus-visible`).
- `--border-focus` is 3:1 or better against every surface it can sit on (checked in the report).

## 8. Components

State colours are always the tokens named.

### Buttons

Height 28px (compact 24px, 12px text), padding 0 `--space-3`, radius `--radius-sm`, 13px medium, icon 16px with `--space-2` gap. Sentence-case verb labels ("Open folder").

| Variant | Rest | Hover | Pressed | Disabled |
|---|---|---|---|---|
| Primary | fill `--accent`, text `--text-on-accent` | `--accent-hover` | `--accent-active` | fill `--state-active`, text `--text-tertiary` |
| Secondary | transparent, 1px `--border-default`, text `--text-primary` | `--state-hover`, border `--border-strong` | `--state-active` | border `--border-subtle`, text `--text-tertiary` |
| Ghost | transparent, no border, `--text-primary` | `--state-hover` | `--state-active` | text `--text-tertiary` |
| Danger | fill `--status-error`, text `--text-inverse` | overlay `--state-active` | overlay `--state-active` | as primary |

One primary button per view region. Danger appears only in a confirmation step. High contrast adds a 1px `--border-strong` to primary and danger.

### Inputs

Height 28px, padding 0 `--space-2`, fill `--surface-input`, 1px `--border-default`, radius `--radius-sm`, text `--text-primary`, placeholder `--text-tertiary`. Hover border `--border-strong`. Focus: border `--border-focus` plus the 2px ring inset. Error: border `--status-error`, message below in `--status-error` 12px with an icon. Disabled: border `--border-subtle`, text `--text-tertiary`. Number inputs are 72px wide, right-aligned, tabular figures. Labels sit above or to the left, never as placeholder only.

### Toggles

Track 28 x 16, radius 4px, 1px border. Knob 10 x 10, radius 2px. Off: transparent track, border and knob `--toggle-off`. On: track `--accent`, knob `--text-on-accent`, knob moves 12px over `--motion-base`. Role `switch` with `aria-checked`. State never depends on colour alone: the knob position differs. The label is always adjacent text.

### Selects

Same box as inputs, 168px default, chevron-down icon (16px, `--text-secondary`) at the right. The list is a menu (below) with a check icon on the selected option. Type-ahead and arrow keys must work.

### Tabs (editor)

Height 36px. Inactive: fill `--surface-titlebar`, text `--text-secondary`. Hover: `--state-hover`, text `--text-primary`. Active: fill `--surface-editor`, text `--text-primary`, 2px `--accent` line on top, merged with the editor (no bottom border). Tabs are separated by a 1px divider. Padding 0 `--space-2` 0 `--space-3`; close button 20 x 20 with a 14px x. **Dirty:** an 8px `--text-secondary` dot replaces the close icon and becomes an x on hover. **Preview:** label in italics. Tabs are not git-coloured.

### Panel tabs

Height 32px, 12px medium. Active: `--text-primary` with a 2px `--accent` underline inset `--space-3`. Counts sit in a 16px `--radius-sm` chip filled `--state-active`.

### Tree rows

Height 24px. Padding-left `--space-2` + 16px per level; chevron 16px (`--text-tertiary`), then a 16px icon (`--text-secondary`), 4px gap, name (13px, ellipsis). Indent guides are 1px `--border-subtle`, centred under the parent chevron. States: hover `--state-hover`; selected (tree not focused) `--state-selected`; selected and focused `--state-selected-focus` with a 2px `--accent` bar at the left edge. Keyboard focus adds the standard ring inset.

**Git decorations:** name and a 12px right-aligned status letter (semibold 11px) in the git colour: M `--git-modified`, U `--git-untracked`, A `--git-added`, D `--git-deleted` (name struck through), conflict `--git-conflict`, ignored `--git-ignored`. A collapsed folder that contains changes shows a 6px dot in the strongest child status colour. Expose the status in `aria-label` ("Modified"); colour is never the only signal.

### List rows

24px, padding 0 `--space-3`, 13px. Same state model as tree rows. Secondary text (paths, descriptions) is 12px `--text-secondary` or `--text-tertiary`. Group headers are 24px, 11px semibold, `--text-tertiary`, sentence case.

### Menus

Floating list: fill `--surface-raised`, 1px float border, radius `--radius-md`, `--shadow-raised`, padding `--space-1` 0, min width 208px. Items 24px, padding 0 `--space-3`, label left, keybinding right in 12px `--text-secondary`. Hover and keyboard focus: `--state-selected-focus`. Disabled: `--text-tertiary`. Separators are 1px dividers with `--space-1` margin. No icons in items unless they carry state (check). Open on right-click or Shift+F10, close on Esc, return focus to the trigger.

### Command palette

560px wide, centred, 6px below the title bar, `--surface-raised`, float border, `--radius-md`, `--shadow-raised`, no scrim. Input: a 28px field in a `--space-2` padded row, always focused, with the inset ring. Results: group headers and 24px rows. Selected row: `--state-selected-focus` plus a 2px `--accent` left bar. Matched characters: `--text-link`, semibold. Keybinding chips: 18px tall, 11px, `--radius-sm`, 1px `--border-subtle`, fill `--state-hover`, `--text-secondary`; one chip per key. Max height 60vh, scrolls inside. Empty state: "No matching commands".

### Dialogs

Modal over `--surface-scrim`. Width 400 (confirm) to 560px (form), `--surface-raised`, 1px float border, `--radius-lg`, `--shadow-modal`, padding `--space-6`. Title 15px semibold, body 13px `--text-secondary`, actions right-aligned with `--space-2` gap; the primary action is last. Focus moves to the least destructive action; Esc cancels; focus is trapped and returned on close.

### Toasts

344px wide, bottom right, `--space-4` above the status bar. `--surface-raised`, float border, `--radius-md`, `--shadow-raised`, padding `--space-3`. Layout: 16px status icon, title (semibold), one line of message (12px `--text-secondary`), up to two actions (compact secondary and ghost), close button. Fade in over `--motion-base`. Errors stay until dismissed; success and info dismiss after 6 seconds unless hovered or focused. `role="status"` (errors: `role="alert"`). Stack at most three.

### Badges

- **Count badge** (activity bar): min 16 x 16, radius 6px, fill `--accent`, `--text-on-accent`, 10px semibold, offset 6px from the icon's top-right.
- **Count chip** (panel tabs): see Panel tabs.
- **Status pill** (rare): 18px tall, `--radius-sm`, `--status-*-bg` fill with `--status-*` text and an icon.

### Banners

Inline, full width of the container, padding `--space-2` `--space-3`, 1px border and 16px icon in the status colour, fill `--status-*-bg`, body text `--text-primary` 13px, optional ghost action at the right. One banner per region.

### Status bar

Height 24px, `--surface-statusbar`, top hairline, text 12px `--text-secondary`, icons 14px. Items are buttons: padding 0 `--space-2`, hover `--state-hover` and `--text-primary`. Left: branch, sync ("1 ahead"), errors, warnings (icons in `--status-error` / `--status-warning`; counts stay `--text-secondary`). Right: Ln/Col, Spaces, encoding, EOL, language, then the quiet **Managed** indicator (shield icon `--text-tertiary`, label `--text-secondary`; shown only when policy applies). **Restricted Mode badge:** leftmost, full height, fill `--status-warning-bg`, 1px right border `--status-warning`, 14px shield-alert icon in `--status-warning`, label `--text-primary` 12px medium. The status bar never changes colour to signal state.

### Scrollbars

Overlay style, 10px wide zone with a 6px thumb inset 2px, radius `--radius-sm`, track `--scrollbar-track` (transparent). Thumb colours (3:1 or better on their surface): rest `--scrollbar-thumb`, hover `--scrollbar-thumb-hover`, dragging `--scrollbar-thumb-active`. Minimum thumb length 24px. No arrows. Scrollable regions that take keyboard focus show the standard ring. Monaco scrollbars use the same tokens through `themes.ts`.

### Editor furniture

Line numbers 12px `--editor-gutter-fg` (current line `--editor-gutter-fg-active`), current-line fill `--editor-line-highlight` (no border). Git gutter: 3px bars in `--git-added` / `--git-modified`, and a 6px triangle in `--git-deleted` for removed lines. Selection `--editor-selection` (`--editor-selection-inactive` when unfocused). Bracket match: `--editor-bracket-match` fill with a 1px `--border-focus` outline. Squiggles: 1px wavy, `--status-error` / `--status-warning`. Indent guides 1px, the active block uses `--editor-indent-guide-active`. Minimap: syntax-coloured blocks at 70% opacity, viewport shade `--minimap-slider`.

### Settings rows

Row padding `--space-3` `--space-3` `--space-3` `--space-4`, 1px bottom hairline. Title: category prefix in `--text-secondary`, name semibold. Description 12px `--text-secondary`, max 460px. Control right-aligned. **Modified:** a 2px `--accent` bar at the row's left edge plus a "Modified" text tag with a reset icon; never colour alone. **Locked:** row fill `--state-hover`, lock icon before the title, control at 60% and non-interactive, and the line "Managed by your organization" with a shield icon under the description.

## 9. Empty states and copy

- Structure: a bold one-line title stating the situation, one short sentence saying what to do, one primary action, optional shortcut in `--text-tertiary`. Example: "You have not opened a folder" / "Open a folder to browse files and use source control." / [Open folder].
- No illustrations, icons larger than 16px, or humour.
- Sentence case everywhere ("Open folder", not "Open Folder"). The product name ".inc" is always lowercase with the leading dot.
- Say what happened, then what to do. Errors: "Could not save api.ts. The file is read-only." Not "Oops! Something went wrong."
- Use "your organization" for managed policy, and state who controls a locked value: "Managed by your organization".
- Numbers and units: "30 seconds", "1 of 19 tests failed". Keys: "Ctrl+Shift+P" in text; chips in UI.
- No exclamation marks, no emoji, no "please", no ellipsis unless a command needs more input.

## 10. High contrast

Both HC themes use pure black or white surfaces, so tonal steps disappear: region dividers, floating-surface borders and tab dividers use `--border-strong`. Shadows are `none`. Text is 7:1 or better on all surfaces (4.5:1 inside translucent selection, find and bracket overlays). Primary and danger buttons get a 1px `--border-strong`. The focus ring offset is 2px. Never rely on a fill difference to separate regions in HC.

## 11. Do and do not

| Do | Do not |
|---|---|
| Use tokens for every colour, space and radius | Hard-code hex, rgb() or off-grid pixels |
| Separate regions with a 1px hairline | Add card borders and shadows to everything |
| Use the accent for fills, indicators and focus | Use the accent for body text; use `--text-link` |
| Pair every status colour with an icon or text | Communicate state with colour alone |
| Show both a fill and a position change on toggles | Use a pill toggle with a glowing knob |
| Keep radii at 2, 4 or 6px | Round buttons fully or use 8px+ radii |
| Test in all four themes and at 200% zoom | Ship only a dark-theme screenshot |
| Give icon-only buttons a label and tooltip | Fill icons or mix icon libraries |
| Write sentence-case, plain copy | Use title case, exclamation marks or emoji |
| Respect `prefers-reduced-motion` via the motion tokens | Hard-code durations or add looping animation |
| Keep locked settings visible and say who manages them | Hide managed settings silently |

## 12. Verification

Every colour pairing in the token table is measured for all four themes. Re-run the contrast script whenever `tokens.css` changes and commit the updated `docs/contrast-report.md`; a failing check blocks the change. The report lists two documented exemptions (ANSI black as text on dark terminals). Disabled controls are exempt from contrast by WCAG but stay legible (locked rows keep `--text-secondary` values at 60% opacity).
