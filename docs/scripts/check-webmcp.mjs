// Checks the WebMCP tools against the production build: `next start` on a free
// port, Playwright's Chromium, and a stubbed modelContext injected before any
// page script runs. It proves the shipped bundle registers exactly the three
// read-only tools on document.modelContext (navigator.modelContext only as the
// fallback), that each handler returns real data from the site's own routes,
// and that a browser without WebMCP sees no errors.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APEX = "https://tmux-ide.com/";
const TOOL_NAMES = ["get_install_command", "get_page_markdown", "search_docs"];
const DEADLINE_MS = 120_000;

if (!existsSync(join(docsDir, ".next/BUILD_ID")))
  throw new Error("No production docs build found: run `next build` first.");

const siteSource = readFileSync(join(docsDir, "lib/site.ts"), "utf8");
const INSTALL_COMMAND = /export const INSTALL_COMMAND = "([^"]+)";/u.exec(siteSource)?.[1];
if (!INSTALL_COMMAND) throw new Error("INSTALL_COMMAND not found in lib/site.ts");

const require = createRequire(resolve(docsDir, "package.json"));
const { chromium } = require("@playwright/test");

// Vercel's build image has no browser; CI and local builds install Chromium, so a
// missing browser fails everywhere else.
if (process.env.VERCEL && !existsSync(chromium.executablePath())) {
  console.log("check-webmcp: skipped on Vercel (no Chromium in the build image)");
  process.exit(0);
}

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const failures = [];
function expect(condition, label, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
    failures.push(label);
  }
}

// Runs in the page before its scripts. `where` picks which stubs exist.
function installStub(where) {
  const make = () => ({
    tools: [],
    options: [],
    registerTool(tool, options) {
      this.tools.push(tool);
      this.options.push(options);
      return Promise.resolve();
    },
  });
  const stubs = {};
  if (where !== "navigator") {
    stubs.document = make();
    Object.defineProperty(Document.prototype, "modelContext", {
      configurable: true,
      get: () => stubs.document,
    });
  }
  if (where !== "document") {
    stubs.navigator = make();
    Object.defineProperty(Navigator.prototype, "modelContext", {
      configurable: true,
      get: () => stubs.navigator,
    });
  }
  Object.defineProperty(window, "__webmcpStubs", { value: stubs });
}

async function openWithStub(browser, base, where) {
  const page = await browser.newPage();
  await page.addInitScript(installStub, where);
  await page.goto(base, { waitUntil: "networkidle" });
  const target = where === "navigator" ? "navigator" : "document";
  await page
    .waitForFunction((key) => window.__webmcpStubs[key].tools.length >= 3, target, {
      timeout: 15_000,
    })
    .catch(() => undefined);
  // Settle, so a fourth or late registration would be counted.
  await page.waitForTimeout(500);
  return page;
}

const countsOf = (page) =>
  page.evaluate(() => ({
    document: window.__webmcpStubs.document?.tools.length ?? null,
    navigator: window.__webmcpStubs.navigator?.tools.length ?? null,
  }));

async function checkRegistration(page) {
  const tools = await page.evaluate(() =>
    window.__webmcpStubs.document.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      schemaType: tool.inputSchema?.type,
      schemaIsObject: typeof tool.inputSchema === "object" && tool.inputSchema !== null,
      readOnly: tool.annotations?.readOnlyHint === true,
      executable: typeof tool.execute === "function",
      signal: window.__webmcpStubs.document.options[index]?.signal instanceof AbortSignal,
    })),
  );
  const names = tools.map((tool) => tool.name).sort();
  expect(
    JSON.stringify(names) === JSON.stringify(TOOL_NAMES),
    "exactly the three tools register on document.modelContext",
    `got ${JSON.stringify(names)}`,
  );
  for (const tool of tools) {
    expect(
      typeof tool.description === "string" && tool.description.length > 20,
      `${tool.name} has a description`,
    );
    expect(
      tool.schemaIsObject && tool.schemaType === "object",
      `${tool.name} has an object inputSchema`,
    );
    expect(tool.readOnly, `${tool.name} is annotated readOnlyHint: true`);
    expect(tool.executable, `${tool.name} has an execute function`);
    expect(tool.signal, `${tool.name} registers with an AbortSignal`);
  }
}

const rejected = (result) =>
  typeof result.error === "string" && !result.error.startsWith("no tool");

const call = (page, name, input) =>
  page.evaluate(
    async ([toolName, toolInput]) => {
      const tool = window.__webmcpStubs.document.tools.find((entry) => entry.name === toolName);
      if (!tool) return { error: `no tool ${toolName}` };
      try {
        const value = await tool.execute(toolInput, { signal: new AbortController().signal });
        return { value: JSON.parse(JSON.stringify(value)) };
      } catch (error) {
        return { error: String(error) };
      }
    },
    [name, input],
  );

async function checkHandlers(page) {
  const search = await call(page, "search_docs", { query: "restore" });
  const results = Array.isArray(search.value) ? search.value : [];
  expect(results.length >= 1, 'search_docs finds results for "restore"', JSON.stringify(search));
  expect(
    results.length > 0 &&
      results.every(
        (result) =>
          typeof result.url === "string" &&
          result.url.startsWith(`${APEX}docs`) &&
          typeof result.title === "string" &&
          result.title.length > 0 &&
          typeof result.snippet === "string" &&
          !result.snippet.includes("<mark>"),
      ),
    "search_docs returns {title, apex url, plain snippet}",
    JSON.stringify(results.slice(0, 2)),
  );
  expect(
    results.some((result) => result.url.startsWith(`${APEX}docs/restore-resume`)),
    "search_docs finds the restore page",
  );
  const limited = await call(page, "search_docs", { query: "restore", limit: 2 });
  expect(limited.value?.length === 2, "search_docs honours limit", JSON.stringify(limited));
  const empty = await call(page, "search_docs", { query: "" });
  expect(rejected(empty), "search_docs rejects an empty query");

  for (const path of [
    "/docs/getting-started",
    `${APEX}docs/getting-started`,
    "docs/getting-started.md",
  ]) {
    const markdown = await call(page, "get_page_markdown", { path });
    const text = typeof markdown.value === "string" ? markdown.value : "";
    expect(
      text.startsWith("# ") || text.startsWith("---"),
      `get_page_markdown(${JSON.stringify(path)}) returns Markdown`,
      JSON.stringify(markdown).slice(0, 160),
    );
    expect(text.includes("tmux-ide app"), `get_page_markdown(${JSON.stringify(path)}) is the page`);
  }
  for (const path of [
    "/api/search",
    "/docs/../api/search",
    "https://example.com/docs/getting-started",
    "//example.com/docs/getting-started",
    "/llms.txt",
    // /agents.md exists, so only the /docs guard rejects it.
    "/agents",
  ]) {
    const result = await call(page, "get_page_markdown", { path });
    expect(
      rejected(result),
      `get_page_markdown rejects ${JSON.stringify(path)}`,
      JSON.stringify(result).slice(0, 160),
    );
  }

  const install = await call(page, "get_install_command", {});
  expect(
    install.value?.install === INSTALL_COMMAND,
    "get_install_command returns INSTALL_COMMAND",
    JSON.stringify(install),
  );
  expect(install.value?.run === "tmux-ide app", "get_install_command returns the app command");
  expect(
    install.value?.alternative === "npm install -g tmux-ide",
    "get_install_command returns the npm alternative",
  );
}

// Playwright's Chromium ships an early WebMCP build behind this flag. When it
// exposes a way to list tools, the real API must accept and list all three;
// when it does not, the case is skipped rather than failed.
async function checkNativeApi(url) {
  const native = await chromium.launch({ args: ["--enable-experimental-web-platform-features"] });
  try {
    const page = await native.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const listed = await page.evaluate(async () => {
      if (typeof document.modelContext?.getTools === "function")
        return (await document.modelContext.getTools()).map((tool) => tool.name);
      if (typeof navigator.modelContextTesting?.listTools === "function")
        return (await navigator.modelContextTesting.listTools()).map((tool) => tool.name);
      return null;
    });
    if (listed === null) {
      console.log(`  skip Chromium ${native.version()} exposes no WebMCP tool listing`);
      return;
    }
    expect(
      JSON.stringify([...listed].sort()) === JSON.stringify(TOOL_NAMES),
      `Chromium ${native.version()}'s own WebMCP API lists the three tools`,
      JSON.stringify(listed),
    );
  } finally {
    await native.close();
  }
}

async function checkWithoutWebMcp(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Vercel Analytics loads /_vercel/insights/script.js, which only exists on Vercel.
    if (`${message.text()} ${message.location().url}`.includes("/_vercel/insights/")) return;
    errors.push(`console: ${message.text()} (${message.location().url})`);
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => ({
    documentHasIt: "modelContext" in document,
    navigatorHasIt: "modelContext" in navigator,
  }));
  expect(
    errors.length === 0,
    `${new URL(url).pathname} without WebMCP logs no errors`,
    errors.join(" | "),
  );
  expect(
    !state.documentHasIt && !state.navigatorHasIt,
    `${new URL(url).pathname} without WebMCP defines no modelContext`,
    JSON.stringify(state),
  );
  await page.close();
}

const port = await freePort();
const server = spawn(join(docsDir, "node_modules/.bin/next"), ["start", "-p", String(port)], {
  cwd: docsDir,
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}/`;
let browser;
const deadline = setTimeout(() => {
  console.error(`check-webmcp: no result within ${DEADLINE_MS / 1000} s`);
  server.kill("SIGTERM");
  process.exit(1);
}, DEADLINE_MS);

try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      if (attempt > 150) throw new Error("next start did not become ready");
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  browser = await chromium.launch();

  console.log("document.modelContext stub on /:");
  const page = await openWithStub(browser, base, "document");
  await checkRegistration(page);
  await checkHandlers(page);
  await page.close();

  console.log("both stubs on /:");
  const both = await openWithStub(browser, base, "both");
  const bothCounts = await countsOf(both);
  expect(
    bothCounts.document === 3 && bothCounts.navigator === 0,
    "document.modelContext wins over navigator.modelContext",
    JSON.stringify(bothCounts),
  );
  await both.close();

  console.log("navigator.modelContext stub only, on /docs/getting-started:");
  const fallback = await openWithStub(browser, `${base}docs/getting-started`, "navigator");
  const fallbackCounts = await countsOf(fallback);
  expect(
    fallbackCounts.navigator === 3,
    "navigator.modelContext is the fallback",
    JSON.stringify(fallbackCounts),
  );
  await fallback.close();

  console.log("Chromium's own WebMCP API, on /:");
  await checkNativeApi(base);

  console.log("no WebMCP:");
  await checkWithoutWebMcp(browser, base);
  await checkWithoutWebMcp(browser, `${base}docs/getting-started`);
} finally {
  clearTimeout(deadline);
  await browser?.close();
  server.kill("SIGTERM");
}

if (failures.length > 0) {
  console.error(`check-webmcp: ${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("WebMCP tools verified: three read-only tools, real data, no errors without WebMCP.");
