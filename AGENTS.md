# AGENTS.md

## Project Rules

- Do not change token parsing, dedupe, import, export, or snapshot logic unless the task explicitly asks for data behavior changes.
- UI changes require visual verification with `npm run visual:test` or the bundled Node equivalent.
- Keep public/static mode, browser import mode, and local Node mode working after every change.
- Do not hide estimated data from the product. It may be moved out of the header, but it must remain visible in metric cards, details, exports, or settings where relevant.

## UI Acceptance Checklist

- No horizontal scrolling at 1920, 1366, or mobile widths.
- Header must not feel like a debug console. Keep primary title and essential actions only.
- Overview should show useful first-screen information without repeated status cards.
- Task Review panels must align visually; tables should not require horizontal scrolling at 1366px.
- Charts must have clear hover data, readable labels, and professional spacing.
- Empty states must explain the reason and provide an action.

## Mistake Log

- 2026-06-03: The location/weather button was treated as a minor UI issue, but the real problem was incomplete behavior. Fixes must verify the click path, permission handling, and user-visible error/success states.
- 2026-06-03: Task Review was visually checked too loosely. Left task distribution and right sample table had different density and alignment, causing obvious imbalance.
- 2026-06-03: The high-consumption task table still depended on horizontal scrolling. For dashboard pages, compact columns and truncation are preferred over sideways scrolling.
- 2026-06-03: Header retained too much operational metadata. Mode and estimated-data warnings should be moved into status/settings/detail contexts instead of sitting below the main title.
- 2026-06-03: The cache hit trend chart used too much vertical space for too little information. Trend modules should show richer multi-metric usage data with tooltips and compact layout.

## Before Finishing

- Run build.
- Run visual test screenshots.
- Inspect at least Overview and Task Review screenshots manually.
- Update `CHANGELOG.md` and version metadata when the visible product changes.
