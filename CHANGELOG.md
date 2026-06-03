# Changelog

## 0.4.7 - 2026-06-03

- Reverted the GitHub Pages workflow to stable official action versions.
- Added `enablement: true` to `actions/configure-pages` so first-time Pages setup can be enabled by the workflow when permissions allow it.
- Kept the static build path unchanged; dashboard runtime and data logic were not changed.

## 0.4.6 - 2026-06-03

- Adjusted the GitHub Pages workflow to match the recommended build/deploy structure.
- Moved `configure-pages` into the build job before artifact upload.
- Updated GitHub Actions runtime versions to reduce Node 20 deprecation warnings.
- Documented that first-time GitHub Pages deployment still requires the repository Pages source to be set to GitHub Actions.

## 0.4.5 - 2026-06-03

- Added GitHub Pages deployment workflow as a Netlify-free static hosting option.
- The workflow builds the existing static dashboard with `npm run build` and publishes `dist/`.
- No token parsing, import/export, snapshot, or dashboard data logic changed.

## 0.4.4 - 2026-06-03

- Added `AGENTS.md` with project rules, UI acceptance requirements, and a mistake log for repeated UI and interaction issues.
- Fixed the Today Status location/weather flow with explicit geolocation permission handling, HTTPS/local checks, Open-Meteo weather lookup, local caching, and user-visible error states.
- Simplified the header by moving current mode into Status Details, placing the last update next to the title, and hiding the global estimated-data badge from the top-level layout.
- Reworked Task Review alignment so distribution and sample panels use balanced columns, muted empty-task summaries, and a compact no-horizontal-scroll sample table.
- Replaced the oversized cache hit rate trend with a compact multi-series usage trend for input, output, cache creation, cache hit, and active tokens.
- Updated Settings/About privacy text to reflect that weather requests only happen after explicit location authorization.

## 0.4.3 - 2026-06-02

- Tightened the dashboard density by reducing header height, card padding, oversized status blocks, and the desktop wrapping breakpoint.
- Rebuilt the Overview first screen around one Today Status card plus compact core metrics, removing duplicate daily cards, the overview Top Sessions panel, and the Next Steps panel.
- Changed Overview model statistics into a compact ranked list so the lower overview area no longer leaves large blank panels.
- Fixed the Today Status location button by adding the missing click handler for the overview status area.
- Fixed AI Calendar scope so its 90-day heatmap uses the date-range-independent calendar record set while preserving source/model/search/estimate filters.
- Renamed the calendar "monthly active days" stat to range active days to avoid implying older May usage was missing when the current month is June.
- Centered the AI Calendar heatmap matrix and kept empty dates visible as low-emphasis cells.
- Reworked Task Review type cards into a stable grid with empty categories shown as muted cards instead of a collapsible block.
- Fixed a 1366px horizontal overflow in the input/output/cache ratio legend with a dedicated compact legend layout.

## 0.4.2 - 2026-06-02

- Simplified the dashboard header so it focuses on the product name, mode, update time, status details, and core data actions.
- Moved author and deeper status context into Settings/About instead of repeating it in the header.
- Reworked page-specific filters so Overview, AI Calendar, Task Review, Detail Table, and Settings use different filter density.
- Changed long-lived success notices into toast messages and reduced the estimated-data warning into a compact badge.
- Improved the AI Calendar with a complete 90-day heatmap matrix, clearer tooltip data, larger legend, and explicit click-to-drilldown empty states.
- Improved Task Review hierarchy, keyword classification, task summaries, non-empty type priority, folded empty types, and sample sorting.
- Refined Detail Table and Settings/About visual hierarchy, table readability, selected-row states, and formal settings cards.
- Reduced visual noise by softening the page grid and normalizing source colors, badges, card spacing, and responsive breakpoints.

## 0.4.1 - 2026-06-02

- Added `docs/UI_ACCEPTANCE.md` with page-level visual standards, failure rules, and the required visual report template.
- Added Playwright-based `visual:shot` and `visual:test` scripts for screenshot capture and automated UI smoke checks.
- Added screenshot output under `docs/screenshots/current/` and ignored it by default to avoid committing local usage data.
- Fixed responsive overflow found during visual testing in the mobile toolbar and 1366px overview chart layout.
- Added an inline SVG favicon to remove the browser 404 noise during visual checks.
- Documented the visual acceptance workflow in README.

## 0.4.0 - 2026-06-02

- Added page-level navigation for Overview, AI Usage Calendar, Task Review, Detail Table, and Settings/About.
- Added a Today Status module with local time, current-day token usage, active tokens, cache hit rate, optional browser geolocation, and no external weather API calls.
- Added dashboard story cards that summarize recent 7-day movement, peak usage day, source mix, and data quality.
- Added an AI usage calendar heatmap with metric switching, hover tooltips, and click-to-filter day drilldown into the detail table.
- Added rule-based task review for coding, debugging, frontend UI, docs, deployment, data analysis, refactoring, planning, and unknown tasks.
- Added browser-local manual task classification overrides stored in `localStorage`.
- Updated demo data generation with simulated task scenarios so the public Netlify demo exercises the new calendar and task review modules.
- Updated README documentation for the new page structure, task review logic, and privacy behavior.

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
