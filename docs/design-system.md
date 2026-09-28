# SCOPE design system

The dashboard should read like an instrument: calm surfaces, precise type, and color that only
appears when it means something. This document is the contract for anyone changing
`apps/web`. The implementation lives in `apps/web/src/styles.css` (tokens) and
`apps/web/src/ui/` (primitives); charts are in `apps/web/src/charts/`.

## Principles

1. **Data is the loudest thing on the page.** Chrome is hairlines and neutral surfaces. No
   gradients, glows, illustrations or decorative motion.
2. **Color means something or it is not there.** Status colors mean good/bad and always come with
   an icon and a label. Everything else is ink.
3. **Every view answers a question** — the page and chart descriptions say which one. A chart
   that answers nothing is removed, not styled.
4. **Honest numbers.** Estimated costs say "estimated"; unknown prices say "unknown"; token
   counts estimated locally carry `~`; heuristic and model evaluators say what kind of judgment
   they are.
5. **Keyboard and screen reader first-class**, in both themes (see Accessibility).

## Tokens

All colors are CSS custom properties declared once with `light-dark()`; the theme is the OS
setting unless the user picks one (`data-theme` on `<html>`). Tailwind utilities map to tokens
(`bg-panel`, `text-fg-2`, `border-line`…) through `@theme inline`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f6f6f4` | `#111110` | page |
| `--panel` | `#fcfcfb` | `#1a1a19` | panels, sidebar, chart surface |
| `--raised` | `#ffffff` | `#222221` | inputs, popovers, dialogs |
| `--sunken` | `#f1f0ec` | `#141413` | code blocks, neutral badges |
| `--border` / `--border-strong` | 10% / 20% ink | 10% / 20% white | hairlines / control outlines |
| `--text` | `#1b1b19` | `#f2f2f0` | primary ink |
| `--text-2` | `#52514e` | `#c3c2b7` | secondary ink |
| `--text-3` | `#6f6e69` | `#9a9990` | muted ink (labels, metadata) |
| `--accent` | `#2a78d6` | `#3987e5` | focus rings, meters, chart series 1 |
| `--accent-text` | `#1f63b8` | `#6aa6ee` | links |
| `--accent-solid` | `#1f63b8` | `#256abf` | filled buttons (white text ≥ 5.4:1) |
| `--good` / `--good-text` | `#0ca30c` / `#006300` | `#0ca30c` / `#3fbf3f` | passed |
| `--warn` / `--warn-text` | `#fab219` / `#8a5300` | `#fab219` / `#f0b43c` | warnings |
| `--bad` / `--bad-text` | `#d03b3b` / `#b42323` | `#d03b3b` / `#f07474` | failed, errored |

Every text token clears WCAG AA (4.5:1) on the panel surface and on the status washes in both
themes (measured, not eyeballed). Status *marks* use the fixed status steps; status *text* uses
the `-text` steps of the same hue.

**Type.** IBM Plex Sans for UI, IBM Plex Mono for ids, code and span kinds, self-hosted (no
font CDN). Sizes: 11px (`text-2xs`, labels), 12px, 13px (tables), 14px (body), 20px (page
titles), 24px (stat values). Numbers in columns use `tabular-nums` (`.tabular`); standalone
figures keep proportional digits.

**Shape.** Radius 3px (badges), 5px (controls), 8px (panels). Borders are 1px hairlines. The only
shadow is on floating layers (popovers, dialogs, the command palette).

## Primitives (`apps/web/src/ui`)

| Primitive | Rule |
| --- | --- |
| `Panel` | The unit of a page: a titled section with an optional description and actions |
| `PageHeader` | Eyebrow (breadcrumb), title with status badges, one line of facts, actions on the right |
| `StatTile` / `StatRow` | A single current value + one line of context + optional sparkline |
| `Meter` | One ratio against a full same-hue track; value printed beside it |
| `CellBar` | In-table data bar scaled to the column maximum; the number is always printed |
| `Pill`, `OutcomeBadge`, `RunResult` | Status with icon + label; tones `good`, `bad`, `warn`, `info`, `neutral` |
| `KindBadge` | Evaluator kind with its definition on hover/focus |
| `Table`, `TR to=…` | Rows that open something contain a real link; the whole row is clickable too |
| `CodeBlock` | Long content: wraps, collapses past 280px, copies, focusable when scrollable, and states truncation and redaction |
| `Segmented`, `Select`, `SearchInput` | Native radio/select/search inputs, styled; search debounces 250ms |
| `EmptyState` | What would put data here — with the real command, copyable |
| `ErrorState` | The server's message, hint, status, error code and request id |

Filters live in the URL (`useUrlState`), so every view is linkable and survives reload.
Refetches keep the previous render dimmed rather than flashing a skeleton; skeletons
(`Loading`) appear only on first load.

## Charts

Charts are hand-written SVG ([ADR 0009](./decisions/0009-dashboard-stack.md)) and follow the
data-visualization method used across the dashboard:

- **Form first, color last.** A single value is a stat tile, not a chart. Pass rate per run is a
  column chart; latency over time is a line chart; model comparisons are in-table bars.
- **One y-axis.** Never two scales on one plot.
- **Marks.** Columns ≤ 24px wide with a 4px rounded data-end and a square base; a 2px surface gap
  between stacked segments; lines 2px with round joins; hover markers ≥ 8px with a 2px surface
  ring; solid 1px gridlines one step off the surface.
- **Color jobs.** Series identity uses the categorical slots in fixed order (`--series-1..3`,
  validated for color-vision deficiency on both surfaces; aqua is under 3:1 in light mode, so any
  chart that uses it must be direct-labeled). Good/bad meaning uses status tokens with icons.
  "Emphasis" charts (pass rate by run, traces and errors) keep ordinary marks neutral
  (`--neutral-mark`) so the failures stand out.
- **Labels.** A legend for two or more series; direct end-labels when they do not collide; axis
  labels spaced by their measured width and never repeated. Text never takes a series color.
- **Interaction.** Every chart is focusable: arrow keys move through data points and show the
  same readout as hover. Columns are their own hit targets (the full band height); lines snap a
  crosshair to the nearest x and list every series.
- **Table twin.** Every chart has a "Table" toggle with the same values — tooltips enhance, they
  never gate.

## Accessibility

- Semantic landmarks (`nav`, `main`, labelled sections), a skip link, and visible focus rings
  (2px accent) on every interactive element.
- The trace explorer's span list is an ARIA tree with roving focus (↑↓ ←→ Home End).
- Dialogs (command palette, shortcuts) are Radix primitives with titles and descriptions.
- `prefers-reduced-motion` disables transitions and the loading pulse.
- `npm run test:e2e` runs axe (WCAG 2.1 A/AA) on every page in both themes and fails on any
  serious or critical violation.

## Adding to the dashboard

1. Start from the question the view answers; write it in the page or chart description.
2. Reuse primitives before writing new markup; new colors need a token (with measured contrast
   in both themes), not a hex value in a component.
3. Show real data only. An empty state explains how data gets there; nothing is mocked.
4. Add or extend an E2E test for any new journey.
