# AGENTS.md

## Project Rules

- Do not change token parsing, dedupe, import, export, or snapshot logic unless the task explicitly asks for data behavior changes.
- UI changes require visual verification with `npm run ui:shot`, `npm run ui:audit`, and `npm run ui:report`; `npm run visual:test` remains useful as an additional smoke test.
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
- 2026-06-03: GitHub Pages deployment failure was initially treated like workflow code alone could solve it. First-time Pages deploys also require repository Pages to be enabled and set to GitHub Actions in GitHub settings.
- 2026-06-03: GitHub Actions runtime warnings were over-corrected by bumping action tags too aggressively. Prefer stable documented action versions first; warnings are not deployment failures unless logs say so.
- 2026-06-03: 0.5.0 release metadata was updated in package and changelog but left stale hardcoded values in `index.html`. Release work must search for old visible version strings and snapshot metadata before deploy.
- 2026-06-03: Public static import UI exposed single-file import too prominently and hid the `sessions` folder path. GitHub Pages and Netlify must both provide an obvious folder import action.
- 2026-06-03: Location/weather fixes missed deployment response headers. If geolocation is used, check both button logic and static host `Permissions-Policy`.
- 2026-06-03: RightCode usage can appear as Codex provider `custom`; source classification must treat `custom` as relay instead of leaving it in `unknown`.
- 2026-06-03: Task classification was too broad because short Latin keywords such as `code`, `js`, and `css` matched inside unrelated strings and paths. Use weighted field matching and word boundaries for Latin keywords.
- 2026-06-03: The first Work Replay page overused sci-fi orbit visuals and underused business structure. Replay pages should prioritize timeline, session detail, task lanes, and summary insight over decorative effects.
- 2026-06-03: UI audit rules initially over-reported false P0s by treating custom HTML charts as empty and counting compact range buttons as failed filters. Audit heuristics must match the actual component patterns before judging UI quality.
- 2026-06-04: `npm run ui:shot` and `npm run ui:audit` were run in parallel, causing a local server port race and a false `ERR_CONNECTION_REFUSED`. UI review commands must run sequentially: shot, audit, report.
- 2026-06-04: CHANGELOG was left in English, which made release history hard for the user to verify. User-facing changelog and release notes should be written in Chinese by default.
- 2026-06-04: Task Review trusted cached/imported `taskType: other` as if it were a real provided category, which locked records into "其他 / 未识别" and skipped improved rules. Treat `other` as unknown unless it is a manual override.
- 2026-06-04: Task Review focused on task labels but missed the user's real accounting question: token usage by concrete project. Project aggregation should use Codex `cwd / workspace` first, then fall back cautiously.
- 2026-06-08: Weather/location was implemented as a manual button path only. Once the user has granted location permission, normal dashboard refresh should also refresh stale weather data using the saved location.
- 2026-06-08: Work Replay still looked like a separate visual experiment. Replay must share the main dashboard's product language and put project, task, time, and token cost directly in the primary timeline.
- 2026-06-08: Playwright audit passed but manual screenshot review missed obvious blank space in Task Review. Visual QA must inspect whitespace and balance, not only automated P0/P1 rules.
- 2026-06-08: Work Replay did not inherit the main dashboard theme setting and stayed dark on dark-system browsers. Subpages must read shared UI preferences such as `codexTokenTheme`.
- 2026-06-08: Source classification allowed `openai` to win before checking `custom/rightcode`, which can move relay usage into official Plus. Relay hints must have priority over generic provider hints.
- 2026-06-08: Treating bare `model_provider: custom` as relay was wrong after Codex++ wrapped all current sessions as `custom`. Only explicit structured `rightcode/right.codes/relay` hints should become relay; the default fallback still has to match the product accounting rule instead of creating a useless all-unknown dashboard.
- 2026-06-08: The 0.5.6 fallback overcorrected by sending bare `custom + vscode` to `unknown`, which made the dashboard useless for the user's expected accounting. For this product, ambiguous Codex++ sessions should default to official Plus while explicit relay/import hints remain relay.
- 2026-06-08: Source detection based only on turn endpoint evidence missed logs where RightCode was recorded as `conversation.id + provider_name=rightcode`. Use turn endpoint evidence first, then session provider evidence; do not use prompt mentions of `right.codes` as endpoint proof.
- 2026-06-08: Browser/GitHub Pages sessions-folder import did not mirror local Node because it ignored `logs_2.sqlite` and did not apply `last_token_usage` / cumulative-delta rules. Browser import must support selecting `.codex` root and reuse the same accounting policy as local scanning.
- 2026-06-08: Some nested Codex payload ids and model objects were stringified as `[object Object]`, breaking source/session aggregation. Always normalize scalar fields through a safe scalar extractor before writing records.
- 2026-06-08: A manual `sourceRules` idea was misaligned with the user's requirement. Source separation must be automatic where evidence exists: use RightCode config/API-key account shape plus runtime `right.codes` request timestamps; only fall back to official when no relay evidence exists.
- 2026-06-08: Splitting relay by day was invalid because the user mixes official Plus and RightCode on the same day. Source evidence must be turn/request level where possible; date can only be diagnostic context, not an attribution rule.
- 2026-06-08: Exact turnId matching was still insufficient because `.codex/sessions` usage records can carry an aggregate/parent turnId while `logs_2.sqlite` stores the real HTTP request under another turn id. Source attribution must also use endpoint timestamp evidence, preferably scoped by `cwd`, before falling back to provider defaults.
- 2026-06-08: Browser/static import cannot run SQLite queries against `logs_2.sqlite`; when mirroring Node source attribution in GitHub Pages mode, derive request event time from UUIDv7 `turn.id` and keep the same sourceRule labels visible for audit.
- 2026-06-08: Treating any `right.codes` host as relay was too broad. `right.codes/codex/v1` can appear in the user's official validation days, so relay evidence must be path-sensitive and limited to billable RightCode API paths such as `www.right.codes/codex-pro/v1` / `www.right.codes/v1`.
- 2026-06-08: Global nearest endpoint attribution caused cross-project contamination, for example applying `E:\小车\小车上位机设计` RightCode requests to `html-codex-token-codex-plus-token` usage records. Source time evidence must be scoped to the same `cwd` or supported by explicit Codex++ switch intervals.

## Before Finishing

- Run build.
- Run `npm run ui:shot`, `npm run ui:audit`, and `npm run ui:report`.
- Inspect at least Overview and Task Review screenshots manually.
- Update `CHANGELOG.md` and version metadata when the visible product changes.
