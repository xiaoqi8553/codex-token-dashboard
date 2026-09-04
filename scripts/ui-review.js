const fs = require("fs");
const path = require("path");
const http = require("http");
const childProcess = require("child_process");
const Module = require("module");

const root = path.resolve(__dirname, "..");
const docsDir = path.join(root, "docs");
const screenshotsDir = path.join(docsDir, "screenshots", "current");
const auditPath = path.join(docsDir, "ui-audit-report.json");
const reviewPath = path.join(docsDir, "UI_REVIEW_REPORT.md");
const port = Number(process.env.PORT || process.env.CODEX_TOKEN_DASHBOARD_PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const mode = process.argv.includes("--report") ? "report" : process.argv.includes("--audit") ? "audit" : "shot";

const pages = [
  { key: "overview", name: "总览页", view: "overview", screenshot: "overview", url: baseUrl },
  { key: "calendar", name: "AI 使用日历", view: "calendar", screenshot: "calendar", url: baseUrl },
  { key: "tasks", name: "任务复盘", view: "tasks", screenshot: "tasks", url: baseUrl },
  { key: "details", name: "明细表", view: "details", screenshot: "details", url: baseUrl },
  { key: "settings", name: "设置 / 关于", view: "settings", screenshot: "settings", url: baseUrl },
  { key: "settings-bridge", name: "GitHub Pages 账号桥接", view: "settings", screenshot: "settings-bridge", url: `${baseUrl}?accountBridge=1` }
];

const viewports = [
  { key: "1920", width: 1920, height: 1080, deviceScaleFactor: 1 },
  { key: "1366", width: 1366, height: 768, deviceScaleFactor: 1 },
  { key: "mobile", width: 390, height: 844, deviceScaleFactor: 2 }
];

function addBundledPlaywrightPaths() {
  const nodeModules = path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");
  const base = path.join(nodeModules, ".pnpm");
  const paths = [];
  if (fs.existsSync(path.join(nodeModules, "playwright"))) paths.push(nodeModules);
  for (const entry of fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !/^playwright(?:-core)?@/.test(entry.name)) continue;
    const candidate = path.join(base, entry.name, "node_modules");
    if (fs.existsSync(candidate)) paths.push(candidate);
  }
  for (const candidate of paths) {
    if (!Module.globalPaths.includes(candidate)) Module.globalPaths.push(candidate);
  }
  process.env.NODE_PATH = [process.env.NODE_PATH, ...paths].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    addBundledPlaywrightPaths();
    return require("playwright");
  }
}

function browserLaunchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  return executablePath ? { executablePath } : {};
}

function requestStatus(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on("error", () => resolve(0));
    request.setTimeout(1600, () => {
      request.destroy();
      resolve(0);
    });
  });
}

async function waitForServer(url, timeoutMs = 14000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await requestStatus(url)) return true;
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return false;
}

async function ensureServer() {
  if (await requestStatus(baseUrl)) return null;
  const child = childProcess.spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, HOST: host, PORT: String(port), DASHBOARD_AUTO_OPEN: "false" },
    stdio: "ignore",
    windowsHide: true
  });
  if (await waitForServer(baseUrl)) return child;
  child.kill();
  throw new Error(`本地服务启动失败：${baseUrl}`);
}

async function openPage(page, pageInfo) {
  await page.goto(pageInfo.url || baseUrl, { waitUntil: "networkidle" });
  if (pageInfo.view !== "overview") {
    await page.locator(`[data-view="${pageInfo.view}"]`).click();
    await page.waitForTimeout(450);
  }
}

function screenshotName(pageInfo, viewport) {
  return `${pageInfo.screenshot}-${viewport.key}.png`;
}

async function runBrowser({ takeScreenshots, audit }) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  const { chromium } = loadPlaywright();
  let server = null;
  let browser = null;
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    screenshotsDir,
    pages: [],
    consoleErrors: []
  };

  try {
    server = await ensureServer();
    browser = await chromium.launch(browserLaunchOptions());
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor
      });
      const page = await context.newPage();
      page.on("console", message => {
        if (message.type() === "error") report.consoleErrors.push({ viewport: viewport.key, text: message.text() });
      });
      page.on("pageerror", error => report.consoleErrors.push({ viewport: viewport.key, text: error.message }));

      for (const pageInfo of pages) {
        await openPage(page, pageInfo);
        const screenshot = path.join(screenshotsDir, screenshotName(pageInfo, viewport));
        if (takeScreenshots) await page.screenshot({ path: screenshot, fullPage: true });
        const checks = audit ? await collectAudit(page, pageInfo, viewport, screenshot) : { warnings: [], failures: [], metrics: {} };
        report.pages.push({
          page: pageInfo.key,
          name: pageInfo.name,
          viewport: viewport.key,
          width: viewport.width,
          height: viewport.height,
          screenshot,
          warnings: checks.warnings,
          failures: checks.failures,
          metrics: compactMetrics(checks.metrics)
        });
      }

      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
  return report;
}

function compactMetrics(metrics = {}) {
  return {
    scrollWidth: metrics.scrollWidth,
    clientWidth: metrics.clientWidth,
    headerHeight: metrics.header?.height || 0,
    occupiedHeight: metrics.occupiedHeight || 0,
    viewportHeight: metrics.viewportHeight || 0,
    filtersVisible: Boolean(metrics.filtersVisible),
    charts: (metrics.charts || []).map(chart => ({
      selector: chart.selector,
      height: chart.rect?.height || 0,
      hasGraphic: Boolean(chart.hasGraphic),
      hasEmpty: Boolean(chart.hasEmpty)
    })),
    cards: metrics.cards?.length || 0,
    h1Count: metrics.h1?.length || 0,
    activeNav: metrics.activeNav || "",
    kpiBaselineDrift: metrics.kpiBaselineDrift || 0,
    kpiTextInsetDrift: metrics.kpiTextInsetDrift || 0,
    regularBarMinFont: metrics.regularBarMinFont || 0,
    trendValueCenterDrift: metrics.trendValueCenterDrift || 0,
    trendValueOverflowCount: metrics.trendValueOutOfBounds?.length || 0
  };
}

async function collectAudit(page, pageInfo, viewport, screenshot) {
  const data = await page.evaluate(({ pageKey }) => {
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rect = element => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
    };
    const text = element => element?.textContent?.replace(/\s+/g, " ").trim() || "";
    const header = document.querySelector("header, .topbar");
    const filters = document.querySelector(".filters");
    const notices = Array.from(document.querySelectorAll(".notice,.alert,.toast,.banner,.warning,.status-banner"))
      .filter(element => visible(element) && getComputedStyle(element).position !== "fixed");
    const occupiedElements = [header, filters, ...notices].filter(visible);
    const occupied = occupiedElements.reduce((sum, item) => sum + item.getBoundingClientRect().height, 0);
    const isAuditFilterControl = element => {
      if (!visible(element)) return false;
      if (element.closest(".range-filter,.segmented")) return false;
      if (element.classList.contains("date-open") || element.classList.contains("advanced-toggle")) return false;
      if (element.matches(".date-field input[type='date']")) return false;
      if (element.matches(".date-display")) return true;
      if (element.matches("input[type='search'],select")) return true;
      if (element.matches("button") && /清空|筛选|导出|应用/.test(text(element))) return true;
      return false;
    };
    const filterControls = Array.from(document.querySelectorAll(".filters input,.filters select,.filters button")).filter(isAuditFilterControl).map(element => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      text: text(element),
      rect: rect(element)
    }));
    const chartSelectors = ["#trendChart", "#ratioChart", "#cacheTrendChart", ".calendar-heatmap", ".task-layout"];
    const charts = chartSelectors.map(selector => {
      const element = document.querySelector(selector);
      const hasGraphic = Boolean(element?.querySelector("canvas,svg,.bar,.bars,.bar-row,.day,.stack,.stack-outer,.donut,.donut-row,.ratio-row,.track,.fill,.trend-bar,.cache-point,.calendar-cell,.task-type-card"));
      const hasEmpty = /暂无|没有|失败|导入|加载|empty/i.test(text(element));
      return { selector, visible: visible(element), rect: rect(element), text: text(element), hasGraphic, hasEmpty };
    }).filter(item => item.visible);
    const textNodes = Array.from(document.querySelectorAll("body *")).filter(visible).map(element => {
      const styles = getComputedStyle(element);
      const content = text(element);
      const compact = Boolean(element.closest(".badge,.eyebrow,.rail-section-label,.brand-caption,.day-label,.usage-x-axis,.usage-y-label,.trend-total-kicker,th,.pill"));
      return { tag: element.tagName.toLowerCase(), className: String(element.className || ""), fontSize: parseFloat(styles.fontSize) || 0, compact, text: content.slice(0, 80) };
    }).filter(item => item.text);
    const smallTextCount = textNodes.filter(item => item.fontSize && item.fontSize < 12 && !item.compact).length;
    const keyNumbers = Array.from(document.querySelectorAll(".metric.hero .metric-value,.stat-card.hero-stat strong,.today-time,.metric-value")).filter(visible).map(element => ({
      text: text(element),
      fontSize: parseFloat(getComputedStyle(element).fontSize) || 0
    }));
    const overflowTargets = [
      ...Array.from(document.querySelectorAll(".metric-value")),
      ...Array.from(document.querySelectorAll(".trend-total-value")),
      ...Array.from(document.querySelectorAll(".trend-total-row strong")),
      ...Array.from(document.querySelectorAll(".ratio-legend-row"))
    ].filter(visible).map(element => {
      const bounds = element.getBoundingClientRect();
      const owner = element.closest(".metric,.trend-total-card,.ratio-panel");
      const ownerBounds = owner?.getBoundingClientRect();
      const outsideOwner = ownerBounds && (
        bounds.left < ownerBounds.left - 1 ||
        bounds.right > ownerBounds.right + 1 ||
        bounds.top < ownerBounds.top - 1 ||
        bounds.bottom > ownerBounds.bottom + 1
      );
      return {
        selector: element.className || element.tagName.toLowerCase(),
        text: text(element).slice(0, 80),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        outsideOwner: Boolean(outsideOwner)
      };
    }).filter(item => item.outsideOwner || item.scrollWidth > item.clientWidth + 1);
    const metricRows = Array.from(document.querySelectorAll(".metric:not(.hero)")).filter(visible).reduce((rows, card) => {
      const value = card.querySelector(".metric-value");
      if (!visible(value)) return rows;
      const cardTop = Math.round(card.getBoundingClientRect().top / 8) * 8;
      (rows[cardTop] ||= []).push(value.getBoundingClientRect().top);
      return rows;
    }, {});
    const kpiBaselineDrift = Math.max(0, ...Object.values(metricRows).filter(row => row.length > 1).map(row => Math.max(...row) - Math.min(...row)));
    const metricTextInsets = Array.from(document.querySelectorAll(".metric")).filter(visible).map(card => {
      const value = card.querySelector(".metric-value");
      const textNode = value?.firstChild;
      if (!visible(value) || !textNode) return null;
      const range = document.createRange();
      range.selectNodeContents(value);
      return range.getBoundingClientRect().left - card.getBoundingClientRect().left;
    }).filter(value => Number.isFinite(value));
    const kpiTextInsetDrift = metricTextInsets.length ? Math.max(...metricTextInsets) - Math.min(...metricTextInsets) : 0;
    const regularBarFonts = Array.from(document.querySelectorAll('.trend[data-density="regular"] .bar-value')).filter(visible).map(element => parseFloat(getComputedStyle(element).fontSize) || 0);
    const regularBarMinFont = regularBarFonts.length ? Math.min(...regularBarFonts) : 0;
    const trendBounds = document.querySelector("#trendChart")?.getBoundingClientRect();
    const trendValues = Array.from(document.querySelectorAll("#trendChart .day .bar-value")).filter(visible).map(label => {
      const stack = label.closest(".day")?.querySelector(".stack");
      const labelBounds = label.getBoundingClientRect();
      const stackBounds = stack?.getBoundingClientRect();
      return {
        text: text(label),
        centerDrift: stackBounds ? Math.abs((labelBounds.left + labelBounds.width / 2) - (stackBounds.left + stackBounds.width / 2)) : 0,
        outsideChart: Boolean(trendBounds && (labelBounds.left < trendBounds.left - 1 || labelBounds.right > trendBounds.right + 1))
      };
    });
    const trendValueCenterDrift = Math.max(0, ...trendValues.map(value => value.centerDrift));
    const trendValueOutOfBounds = trendValues.filter(value => value.outsideChart);
    const cards = Array.from(document.querySelectorAll(".metric,.stat-card,.today-card,.story-card,.calendar-stat,.task-type-card,.settings-card,.panel,.current-card,.mini-stat")).filter(visible).map(rect);
    const h1 = Array.from(document.querySelectorAll("h1")).filter(visible).map(text);
    const h2 = Array.from(document.querySelectorAll("h2")).filter(visible).map(text);
    return {
      scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      clientWidth: document.documentElement.clientWidth,
      bodyFont: getComputedStyle(document.body).fontFamily,
      header: rect(header),
      occupiedHeight: occupied,
      viewportHeight: window.innerHeight,
      filtersVisible: visible(filters),
      filterControls,
      charts,
      smallTextCount,
      totalTextCount: textNodes.length,
      keyNumbers,
      overflowTargets,
      kpiBaselineDrift,
      kpiTextInsetDrift,
      regularBarMinFont,
      trendValueCenterDrift,
      trendValueOutOfBounds,
      cards,
      h1,
      h2,
      activeNav: text(document.querySelector("#viewTabs button.active,.page-nav button.active")),
      mobileButtons: Array.from(document.querySelectorAll("header button,header select,.side-rail button,.filters button,.filters select,.welcome button,.welcome a")).filter(visible).map(rect)
    };
  }, { pageKey: pageInfo.key });

  const warnings = [];
  const failures = [];
  const add = (level, code, message, detail = {}) => (level === "failure" ? failures : warnings).push({ code, message, detail });

  if (data.scrollWidth > data.clientWidth + 2) add("failure", "horizontal-scroll", "页面存在横向滚动", { scrollWidth: data.scrollWidth, clientWidth: data.clientWidth });
  if ((data.header?.height || 0) > 160) add("failure", "header-too-high", "Header 高度超过 160px", { height: data.header.height });
  else if ((data.header?.height || 0) > 120) add("warning", "header-high", "Header 高度超过 120px", { height: data.header.height });
  if (data.occupiedHeight / data.viewportHeight > 0.35) add("failure", "first-screen-compressed", "首屏 35% 以上高度被 Header / 提示 / 筛选栏占用", { occupiedHeight: data.occupiedHeight, viewportHeight: data.viewportHeight });

  if (data.filtersVisible) {
    for (const control of data.filterControls) {
      if ((control.rect?.width || 0) < 120) add("failure", "filter-control-narrow", "筛选控件宽度小于 120px", { id: control.id, text: control.text, width: control.rect?.width });
    }
    const search = data.filterControls.find(item => /search|搜索/i.test(`${item.id} ${item.text}`));
    if (search && (search.rect?.width || 0) < 280) add("warning", "search-narrow", "搜索框宽度小于 280px", { width: search.rect.width });
  }

  for (const chart of data.charts) {
    if ((chart.rect?.height || 0) < 240) add("failure", "chart-short", "图表区域高度小于 240px", { selector: chart.selector, height: chart.rect?.height });
    if (!chart.hasGraphic && !chart.hasEmpty) add("failure", "chart-empty", "图表区域没有图形，也没有空状态文案", { selector: chart.selector });
  }

  const smallRatio = data.totalTextCount ? data.smallTextCount / data.totalTextCount : 0;
  if (smallRatio > 0.22) add("warning", "small-font", "大量文字小于 12px", { smallTextCount: data.smallTextCount, totalTextCount: data.totalTextCount });
  const tinyNumber = data.keyNumbers.find(item => item.fontSize && item.fontSize < 22);
  if (tinyNumber) add("failure", "key-number-small", "关键数字字号小于 22px", tinyNumber);
  if (data.overflowTargets.length) add("failure", "key-content-overflow", "关键卡片内容超出可用边界或被截断", { targets: data.overflowTargets });
  if (data.kpiBaselineDrift > 4) add("failure", "kpi-value-misaligned", "同一行 KPI 数字基线未对齐", { drift: data.kpiBaselineDrift });
  if (data.kpiTextInsetDrift > 2) add("failure", "kpi-text-misaligned", "KPI 主数字未使用统一左边距", { drift: data.kpiTextInsetDrift });
  if (pageInfo.key === "overview" && data.regularBarMinFont && data.regularBarMinFont < 12) add("failure", "trend-label-small", "低密度每日趋势数值小于 12px", { fontSize: data.regularBarMinFont });
  if (pageInfo.key === "overview" && data.trendValueCenterDrift > 2) add("failure", "trend-value-misaligned", "每日趋势数值未与柱体中心对齐", { drift: data.trendValueCenterDrift });
  if (pageInfo.key === "overview" && data.trendValueOutOfBounds.length) add("failure", "trend-value-overflow", "每日趋势数值超出图表边界", { values: data.trendValueOutOfBounds });
  if (data.cards.length > 24) add("failure", "too-many-cards", "页面卡片数量超过 24 个", { count: data.cards.length });
  else if (data.cards.length > 18) add("warning", "many-cards", "页面卡片数量超过 18 个", { count: data.cards.length });
  if (data.h1.length > 1) add("warning", "multiple-h1", "页面出现多个 h1 主标题", { count: data.h1.length, h1: data.h1 });

  if (viewport.width <= 480) {
    if (!data.activeNav) add("failure", "mobile-nav-missing", "移动端导航不可用或未显示选中状态");
    const crowded = data.mobileButtons.filter(item => (item.width || 0) < 44 || (item.height || 0) < 32);
    if (crowded.length > 2) add("warning", "mobile-buttons-crowded", "移动端多个按钮过窄或过矮", { count: crowded.length });
  }

  return { warnings, failures, metrics: data, screenshot };
}

function statusOf(item) {
  if (item.failures?.length) return "失败";
  if (item.warnings?.length) return "警告";
  return "通过";
}

function severityBuckets(audit) {
  const p0 = [];
  const p1 = [];
  const p2 = [];
  for (const page of audit.pages) {
    for (const issue of page.failures || []) {
      const line = `${page.name} ${page.viewport}: ${issue.message}`;
      if (["horizontal-scroll", "chart-empty", "chart-short", "key-number-small", "key-content-overflow", "kpi-value-misaligned", "kpi-text-misaligned", "trend-label-small", "trend-value-misaligned", "trend-value-overflow", "mobile-nav-missing"].includes(issue.code)) p0.push(line);
      else p1.push(line);
    }
    for (const issue of page.warnings || []) {
      const line = `${page.name} ${page.viewport}: ${issue.message}`;
      if (["header-high", "filter-control-narrow", "search-narrow", "small-font", "multiple-h1"].includes(issue.code)) p1.push(line);
      else p2.push(line);
    }
  }
  for (const error of audit.consoleErrors || []) p0.push(`控制台错误 ${error.viewport}: ${error.text}`);
  return { p0, p1, p2 };
}

function score(audit, kind) {
  const { p0, p1, p2 } = severityBuckets(audit);
  const penalty = p0.length * 1.8 + p1.length * 0.75 + p2.length * 0.12;
  const base = kind === "responsive" ? 9 : kind === "clarity" ? 8.8 : 8.6;
  return Math.max(0, Math.min(10, Number((base - penalty).toFixed(1))));
}

function generateMarkdown(audit) {
  const { p0, p1, p2 } = severityBuckets(audit);
  const byPage = Object.groupBy ? Object.groupBy(audit.pages, item => item.page) : audit.pages.reduce((acc, item) => ((acc[item.page] ||= []).push(item), acc), {});
  const lines = [];
  const visual = score(audit, "visual");
  const clarity = score(audit, "clarity");
  const responsive = score(audit, "responsive");
  lines.push("# UI 视觉验收报告", "");
  lines.push("## 总体结论", "");
  lines.push(`- 视觉完成度：${visual}/10`);
  lines.push(`- 信息清晰度：${clarity}/10`);
  lines.push(`- 响应式适配：${responsive}/10`);
  lines.push(`- 是否达到正式开源项目展示水平：${p0.length ? "否" : p1.length > 6 ? "否" : "是"}`, "");
  lines.push("## 截图位置", "");
  for (const pageInfo of pages) {
    for (const viewport of viewports) {
      lines.push(`- docs/screenshots/current/${screenshotName(pageInfo, viewport)}`);
    }
  }
  lines.push("", "## 页面逐项检查", "");
  for (const pageInfo of pages) {
    const items = byPage[pageInfo.key] || [];
    lines.push(`### ${pageInfo.name}`);
    for (const viewport of ["1920", "1366", "mobile"]) {
      const item = items.find(entry => entry.viewport === viewport);
      lines.push(`- ${viewport}：${item ? statusOf(item) : "未检查"}`);
    }
    const issues = items.flatMap(item => [
      ...(item.failures || []).map(issue => `失败：${item.viewport} ${issue.message}`),
      ...(item.warnings || []).map(issue => `警告：${item.viewport} ${issue.message}`)
    ]);
    lines.push("- 发现的问题：");
    if (issues.length) issues.forEach(issue => lines.push(`  - ${issue}`));
    else lines.push("  - 未发现自动化规则命中的明显问题。");
    lines.push("- 修复建议：");
    const suggestions = suggestionsFor(pageInfo.key, issues);
    suggestions.forEach(item => lines.push(`  - ${item}`));
    lines.push("");
  }
  lines.push("## 重点问题清单", "");
  lines.push("### P0 必须修");
  if (p0.length) p0.forEach(item => lines.push(`- ${item}`));
  else lines.push("- 暂无。");
  lines.push("", "### P1 应该修");
  if (p1.length) p1.forEach(item => lines.push(`- ${item}`));
  else lines.push("- 暂无。");
  lines.push("", "### P2 可优化");
  if (p2.length) p2.forEach(item => lines.push(`- ${item}`));
  else lines.push("- 暂无。");
  lines.push("", "## 下一轮修改建议", "");
  nextSuggestions({ p0, p1, p2 }).forEach(item => lines.push(`- ${item}`));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function suggestionsFor(pageKey, issues) {
  if (!issues.length) return ["保持当前结构，人工复核截图中的视觉观感。"];
  const generic = [];
  if (issues.some(item => item.includes("横向滚动"))) generic.push("优先修复横向溢出，移动端允许局部表格滚动但页面本身不能横向滚动。");
  if (issues.some(item => item.includes("Header"))) generic.push("压缩 Header 高度，把低频状态信息移动到详情区或折叠区。");
  if (issues.some(item => item.includes("筛选"))) generic.push("扩大筛选控件最小宽度，必要时拆成两行。");
  if (issues.some(item => item.includes("图表"))) generic.push("补足图表高度、图形元素或明确空状态。");
  if (!generic.length) generic.push("检查字号、卡片数量和信息层级，减少碎片化卡片。");
  if (pageKey === "tasks") generic.push("任务复盘应继续补充项目/任务维度统计，避免大量记录无法解释。");
  return generic.slice(0, 4);
}

function nextSuggestions({ p0, p1, p2 }) {
  const result = [];
  if (p0.length) result.push("先处理 P0：横向溢出、空白图表和关键内容不可读。");
  if (p1.length) result.push("再处理 P1：Header 高度、筛选栏宽度、字号和信息层级。");
  if (p2.length) result.push("最后处理 P2：统一颜色、减少碎卡、控制背景网格和空白。");
  if (!result.length) result.push("当前自动验收未发现问题；继续维持关键内容边界、深色对比度和人工截图复核门槛。");
  return result.slice(0, 4);
}

async function main() {
  if (mode === "report") {
    if (!fs.existsSync(auditPath)) throw new Error(`缺少 ${auditPath}，请先运行 npm run ui:audit`);
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    fs.writeFileSync(reviewPath, generateMarkdown(audit), "utf8");
    console.log(`UI review report written to ${reviewPath}`);
    return;
  }

  const audit = await runBrowser({ takeScreenshots: mode === "shot", audit: mode === "audit" });
  if (mode === "audit") {
    fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    const { p0, p1, p2 } = severityBuckets(audit);
    console.log(JSON.stringify({ report: auditPath, pages: audit.pages.length, p0: p0.length, p1: p1.length, p2: p2.length, consoleErrors: audit.consoleErrors.length }, null, 2));
  } else {
    console.log(`Screenshots saved to ${screenshotsDir}`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
