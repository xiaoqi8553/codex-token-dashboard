# Changelog

## 0.3.4 - 2026-06-01

- Fixed flattened text in the cache hit rate trend by moving axis labels and date labels out of the non-uniformly scaled SVG.
- Kept SVG rendering for the line, area, and grid only, with non-scaling strokes for cleaner chart geometry.
- Reworked cache trend axis spacing, chart padding, title typography, and marker rendering for a clearer dashboard-style chart.

## 0.3.3 - 2026-06-01

- Standardized compact token formatting to use `K`, `M`, and `B`; values below 1B remain in `M` instead of switching to Chinese `亿`.
- Improved the cache hit rate chart for one-day filters by showing a dedicated single-day summary instead of a flattened line chart.
- Increased cache hit rate chart height and spacing for multi-day trends to improve readability.

## 0.3.2 - 2026-06-01

- Fixed browser-imported `sessions` folder refresh so it can rescan the selected directory instead of only re-rendering cached data.
- Preserved Today / 7 days / 30 days date presets after browser imports and folder refreshes instead of forcing the range back to custom.
- Added IndexedDB persistence for Chrome/Edge directory handles so the public static site can remember a previously selected `sessions` folder when browser permissions allow it.
- Updated browser cache clearing to also remove the remembered `sessions` folder handle.
- Added README guidance for the public URL's remembered-folder behavior and browser permission limits.

## 0.3.1 - 2026-05-30

- Refined the README for open-source presentation with badges, preview images, project structure, FAQ, and topic suggestions.
- Added GitHub-ready project cover and dashboard preview SVG assets under `screenshots/`.
- Added release notes for the 0.3.0 public static demo and local-first import release.
- Documented GitHub Topics recommendations and social preview usage.

## 0.3.0 - 2026-05-29

- Replaced the theme toggle with explicit system/light/dark controls and fixed dark-mode contrast for the total token hero card.
- Added static browser mode for Netlify-style hosting when `/api/usage` is unavailable.
- Added a 30-day public demo dataset that auto-loads on static deployments.
- Added browser-local imports for usage index snapshots, relay CSV/JSON, and `.codex/sessions` folders via the File API.
- Added anonymized JSON and HTML snapshot exports for safe sharing.
- Added Netlify build metadata and a static build check.

## 0.2.0 - 2026-05-29

- Enhanced the dashboard UI with richer metric cards, badges, dark mode, loading states, and denser chart/table layouts.
- Added sortable, paginated, multi-select detail table with selected-record summaries and selected CSV/JSON export.
- Added trend mode switching, cache hit rate trend, richer ratio legend, and Top 10/Top 20 session view.
- Added runtime configuration, local/private default mode, public access guard, authentication requirement, and anonymized public output.
- Added npm scripts, improved Windows launcher, open-source metadata, sample data, and stricter ignore rules.

## 0.1.0 - 2026-05-29

- Added local Codex session scanner, incremental usage index, relay CSV/JSON imports, and first dashboard UI.
