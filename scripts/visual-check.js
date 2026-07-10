const fs = require("fs");
const path = require("path");
const http = require("http");
const childProcess = require("child_process");
const Module = require("module");

const root = path.resolve(__dirname, "..");
const screenshotsDir = path.join(root, "docs", "screenshots", "current");
const port = Number(process.env.PORT || process.env.CODEX_TOKEN_DASHBOARD_PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const mode = process.argv.includes("--test") ? "test" : "shot";

const pages = [
  { name: "overview", label: "总览", view: "overview", file: "overview" },
  { name: "calendar", label: "AI 使用日历", view: "calendar", file: "calendar" },
  { name: "review", label: "任务复盘", view: "tasks", file: "review" },
  { name: "details", label: "明细表", view: "details", file: "details" },
  { name: "settings", label: "设置 / 关于", view: "settings", file: "settings" }
];

const viewports = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1366", width: 1366, height: 768 },
  { name: "mobile", width: 390, height: 844 }
];

function addBundledPlaywrightPaths() {
  const base = path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", ".pnpm");
  const paths = [];
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
    try {
      return require("playwright");
    } catch (error) {
      throw new Error(`Playwright is not available. Install it with "npm i -D playwright", then run the visual script again. ${error.message}`);
    }
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

async function waitForServer(url, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await requestStatus(url)) return true;
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return false;
}

async function ensureServer() {
  if (await requestStatus(baseUrl)) return null;
  const nodePath = process.execPath;
  const child = childProcess.spawn(nodePath, ["server.js"], {
    cwd: root,
    env: { ...process.env, HOST: host, PORT: String(port), DASHBOARD_AUTO_OPEN: "false" },
    stdio: "ignore",
    windowsHide: true
  });
  const ready = await waitForServer(baseUrl);
  if (!ready) {
    child.kill();
    throw new Error(`Local dashboard did not start at ${baseUrl}`);
  }
  return child;
}

async function clickView(page, view) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if (view !== "overview") {
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(350);
  }
}

async function collectChecks(page, pageInfo, viewport) {
  const result = await page.evaluate(({ view, viewportWidth }) => {
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rectOf = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    };
    const activeNav = document.querySelector("#viewTabs button.active");
    const charts = ["#trendChart", "#ratioChart", "#cacheTrendChart"]
      .map(selector => ({ selector, rect: rectOf(selector), visible: visible(document.querySelector(selector)), text: document.querySelector(selector)?.textContent.trim() || "" }));
    const filters = {
      visible: visible(document.querySelector(".filters")),
      from: rectOf(".filter-row.primary .date-field"),
      source: rectOf("#sourceFilter"),
      model: rectOf("#modelFilter"),
      search: rectOf("#searchInput"),
      estimate: rectOf("#estimateFilter")
    };
    const cards = Array.from(document.querySelectorAll(".shell,.panel,.metric,.today-card,.story-card")).filter(visible).map(element => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, left: rect.left, width: rect.width };
    });
    return {
      titlePresent: Boolean(document.querySelector("h1")?.textContent.trim()),
      activeNavPresent: Boolean(activeNav && activeNav.dataset.view === view),
      horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      overflowCards: cards.filter(rect => rect.right > window.innerWidth + 2 || rect.left < -2).length,
      bodyFont: getComputedStyle(document.body).fontFamily,
      filters,
      charts,
      viewportWidth
    };
  }, { view: pageInfo.view, viewportWidth: viewport.width });

  const failures = [];
  if (!result.titlePresent) failures.push("missing main title");
  if (!result.activeNavPresent) failures.push(`missing active nav for ${pageInfo.view}`);
  if (result.horizontalScroll) failures.push("page has horizontal scroll");
  if (result.overflowCards) failures.push(`${result.overflowCards} major cards overflow viewport`);
  if (!/Inter|PingFang|Microsoft YaHei|Noto Sans SC|Segoe UI|sans-serif/i.test(result.bodyFont)) failures.push(`unexpected body font: ${result.bodyFont}`);

  if (viewport.width >= 1000 && result.filters.visible && ["calendar", "tasks", "details"].includes(pageInfo.view)) {
    if ((result.filters.from?.width || 0) < 150) failures.push("date filter is too narrow");
  }
  if (viewport.width >= 1000 && result.filters.visible && ["tasks", "details"].includes(pageInfo.view)) {
    if ((result.filters.source?.width || 0) < 130) failures.push("source filter is too narrow");
    if ((result.filters.model?.width || 0) < 130) failures.push("model filter is too narrow");
  }
  if (viewport.width >= 1000 && result.filters.visible && pageInfo.view === "details") {
    if ((result.filters.search?.width || 0) < 300) failures.push("search input is too narrow");
  }

  if (pageInfo.view === "overview") {
    for (const chart of result.charts.filter(item => item.visible)) {
      if ((chart.rect?.height || 0) < 260) failures.push(`${chart.selector} height is below 260px`);
      if (!chart.text && chart.selector !== "#cacheTrendChart") failures.push(`${chart.selector} has no rendered content`);
    }
  }

  if (viewport.width <= 480 && !result.activeNavPresent) failures.push("mobile nav is not visible");
  return { ...result, failures };
}

async function testCalendarDrilldown(page) {
  await clickView(page, "calendar");
  const cell = page.locator("[data-calendar-day]").last();
  await cell.hover();
  const tooltipVisible = await page.locator(".chart-tooltip.show").isVisible().catch(() => false);
  await cell.click();
  await page.waitForTimeout(500);
  const active = await page.locator("#viewTabs button.active").getAttribute("data-view");
  const from = await page.locator("#fromDate").inputValue();
  const to = await page.locator("#toDate").inputValue();
  return { tooltipVisible, active, from, to, ok: tooltipVisible && active === "details" && from && from === to };
}

async function testDarkMode(page) {
  await clickView(page, "overview");
  await page.locator('[data-theme-choice="dark"]').click();
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const value = document.querySelector(".metric.hero .metric-value");
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const color = value ? getComputedStyle(value).color : "";
    const text = value?.textContent.trim() || "";
    return { ok: Boolean(value && text && color && bodyBg), color, bodyBg, text };
  });
}

async function main() {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const { chromium } = loadPlaywright();
  let server = null;
  let browser = null;
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    mode,
    screenshotsDir,
    checks: [],
    consoleErrors: [],
    interaction: {},
    darkMode: {}
  };

  try {
    server = await ensureServer();
    browser = await chromium.launch(browserLaunchOptions());
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.name === "mobile" ? 2 : 1 });
      const page = await context.newPage();
      page.on("console", message => {
        if (message.type() === "error") report.consoleErrors.push(`[${viewport.name}] ${message.text()}`);
      });
      page.on("pageerror", error => report.consoleErrors.push(`[${viewport.name}] ${error.message}`));

      for (const pageInfo of pages) {
        await clickView(page, pageInfo.view);
        await page.screenshot({
          path: path.join(screenshotsDir, `${pageInfo.file}-${viewport.name}.png`),
          fullPage: true
        });
        const check = await collectChecks(page, pageInfo, viewport);
        report.checks.push({ page: pageInfo.name, viewport: viewport.name, failures: check.failures });
      }

      if (viewport.name === "1366") {
        report.interaction.calendarDrilldown = await testCalendarDrilldown(page);
        report.darkMode = await testDarkMode(page);
      }

      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }

  fs.writeFileSync(path.join(screenshotsDir, "visual-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const failures = report.checks.flatMap(item => item.failures.map(failure => `${item.page}/${item.viewport}: ${failure}`));
  if (report.consoleErrors.length) failures.push(...report.consoleErrors.map(error => `console: ${error}`));
  if (report.interaction.calendarDrilldown && !report.interaction.calendarDrilldown.ok) failures.push("calendar drilldown interaction failed");
  if (report.darkMode && !report.darkMode.ok) failures.push("dark mode smoke test failed");

  console.log(`Screenshots saved to ${screenshotsDir}`);
  console.log(JSON.stringify({
    checks: report.checks.length,
    consoleErrors: report.consoleErrors.length,
    calendarDrilldown: report.interaction.calendarDrilldown?.ok,
    darkMode: report.darkMode?.ok,
    failures
  }, null, 2));

  if (mode === "test" && failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
