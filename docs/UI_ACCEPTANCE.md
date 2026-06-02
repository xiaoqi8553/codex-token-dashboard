# UI Acceptance Guide

This project is a local-first AI usage ledger and Codex Token dashboard. It should feel like a useful data product, not a flashy wall screen or a temporary demo.

## Visual Positioning

- Modern, clean, and professional.
- High information density without crowding.
- Moderate color and icon usage, with no excessive decoration.
- Light mode should feel like a formal admin dashboard.
- Dark mode should feel like a developer tool.
- All text must be crisp, normally proportioned, and readable. Text must not look flattened, fuzzy, or too small.
- Charts must not be empty, blurry, or compressed.
- The filter bar must not collapse into a crowded strip.
- Cards, charts, and tables need clear visual hierarchy.
- The first screen should feel complete, not half-built.

## Failure Standards

Any of these means the UI cannot be accepted:

- The filter bar is squeezed together.
- Chart text is flattened, fuzzy, or too small.
- A chart region is blank and does not show an empty-state explanation.
- Core metric numbers are too small to establish priority.
- The page has horizontal scrolling.
- Mobile content overflows the viewport.
- Dark mode text is hard to read.
- Light mode hierarchy is too weak.
- Buttons, badges, and cards use inconsistent styles.
- UI changes were shipped without screenshots and visual checks.

## Overview Page

- The title is clear and prominent.
- The Today Status card feels consistent with the rest of the dashboard and does not look like a foreign widget.
- Core Token metric numbers are large enough to read at a glance.
- Card icons use a consistent style.
- Chart areas have enough height.
- The daily trend chart is not cramped.
- Cache hit rate trend text is not flattened or compressed.
- Data story card copy is natural and useful.
- The page has no large meaningless blank regions.

## AI Usage Calendar Page

- Heatmap cells are aligned and evenly spaced.
- Color levels are clear but not harsh.
- Hover tooltip is readable.
- Statistic cards are not crowded.
- Clicking a date opens the detail table filtered to that day.
- Empty states explain what is missing and offer an action.

## Task Review Page

- Task type cards are clear and easy to scan.
- Chart-like bars and the table have a balanced layout.
- The "rule-based, reference only" hint is visible but not alarming.
- Task classification badges are visually consistent.
- The page must not look like a pile of temporary tables.

## Detail Table Page

- The filter bar must not be squeezed.
- Date inputs, source/model selects, and search input have reasonable widths.
- Table headers are clear.
- Token numbers are right-aligned.
- Session IDs are truncated but copyable.
- Pagination and multi-select controls are not crowded.
- The table remains usable at 1920px, 1366px, and mobile widths.

## Settings / About Page

- Privacy explanations are clear.
- Local mode, browser import mode, and public demo mode are easy to distinguish.
- Text is grouped into cards instead of one dense block.

## Screenshot Workflow

Run before and after meaningful UI changes:

```bash
npm run visual:shot
npm run visual:test
```

Screenshots are saved to `docs/screenshots/current/`. This folder is ignored by Git because screenshots can contain local usage data.

Required viewport set:

- `1920x1080`
- `1366x768`
- `390x844`

Required pages:

- `overview`
- `calendar`
- `review`
- `details`
- `settings`

## Visual Report Template

```text
视觉验收报告：

1. 总览页
- 布局：
- 字体：
- 图表：
- 空状态：
- 问题：

2. AI 使用日历页
- 布局：
- 色阶：
- tooltip：
- 响应式：
- 问题：

3. 任务复盘页
- 信息层级：
- badge：
- 图表：
- 表格：
- 问题：

4. 明细表页
- 筛选栏：
- 表格：
- 分页：
- 移动端：
- 问题：

5. 设置页
- 文案：
- 卡片：
- 信息层级：
- 问题：

最终评分：
- 视觉完成度：0-10
- 信息清晰度：0-10
- 响应式适配：0-10
- 是否达到正式开源项目展示水平：是 / 否
```
