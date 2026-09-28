# 0009 — Dashboard: React, Vite, Tailwind, Radix, hand-written charts

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

The dashboard is served by the SCOPE server — often from a developer's laptop, sometimes
air-gapped — so it must be a static bundle with no runtime calls to third-party hosts. It must
be accessible and fast with large trace lists.

## Decision

- **React 19 + Vite** single-page app, built to static files served by `@scope-ai/server`.
  No server-side rendering is needed for an authenticated developer tool.
- **Tailwind CSS v4** over a token layer of CSS custom properties (light and dark themes are
  token sets, not inverted colors).
- **Radix UI** primitives for dialog, popover, dropdown menu, tooltip and tabs, because focus
  management and keyboard behaviour for these widgets are easy to get wrong. **cmdk** for the
  command palette.
- **TanStack Query** for server state; the URL is the source of truth for filters.
- **Charts are hand-written SVG components** (bar, line, sparkline, distribution) on the
  design tokens. The dashboard needs four chart shapes; a charting library would dominate the
  bundle and fight the design system.
- Fonts are self-hosted (IBM Plex Sans and IBM Plex Mono, SIL OFL) — no requests to font CDNs.

## Consequences

- The bundle stays small and works offline.
- Chart accessibility (text alternatives, keyboard access to data points) is our
  responsibility; every chart has a table or summary equivalent.

## Alternatives considered

- **Next.js.** SSR and server components add deployment complexity without benefit here.
- **A component kit (MUI, Chakra, shadcn copy-paste).** Faster start, generic look; we want
  an original visual language on accessible headless primitives.
- **Recharts / ECharts.** Capable, but large and hard to theme to a strict token system.
