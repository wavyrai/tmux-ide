import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cspViolation = /content security policy|violates.+style-src/iu;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Vite smoke port allocation returned no TCP address"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function capture(child) {
  const output = { value: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.value += chunk.toString();
    });
  }
  return output;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForRenderer(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before the CSP smoke loaded\n${output.value}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Vite did not become ready within 15 seconds\n${output.value}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
  await waitForExit(child);
  clearTimeout(timeout);
}

async function browserExecutable() {
  const configured = process.env.TMUX_IDE_CHROMIUM_EXECUTABLE;
  const candidates = [
    configured,
    chromium.executablePath(),
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Chromium.app/Contents/MacOS/Chromium"
      : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome-stable" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium-browser" : undefined,
    process.platform === "win32"
      ? join(
          process.env.PROGRAMFILES ?? "C:\\Program Files",
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported system browser location.
    }
  }
  throw new Error(
    "No Chromium browser found. Run `pnpm exec playwright install chromium` or set " +
      "TMUX_IDE_CHROMIUM_EXECUTABLE to run the strict-CSP smoke.",
  );
}

const port = await reservePort();
const rendererUrl = `http://127.0.0.1:${port}/`;
const vite = spawn(
  "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
);
const viteOutput = capture(vite);

try {
  await waitForRenderer(rendererUrl, vite, viteOutput);
  const browser = await chromium.launch({
    executablePath: await browserExecutable(),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1_200, height: 800 } });
    const consoleMessages = [];
    page.on("console", (message) => consoleMessages.push(message.text()));
    await page.addInitScript(() => {
      globalThis.__tmiCspViolations = [];
      globalThis.document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__tmiCspViolations.push({
          blockedURI: event.blockedURI,
          directive: event.effectiveDirective,
          sourceFile: event.sourceFile,
          lineNumber: event.lineNumber,
          columnNumber: event.columnNumber,
          sample: event.sample,
        });
      });
    });
    await page.goto(rendererUrl, { waitUntil: "networkidle" });
    const result = await page.evaluate(() => {
      const frame = [...globalThis.document.querySelectorAll(".web-pane-frame")].find(
        (candidate) => globalThis.getComputedStyle(candidate).display !== "none",
      );
      const viewport = frame?.querySelector(".terminal-surface__viewport");
      const frameRect = frame?.getBoundingClientRect();
      const viewportRect = viewport?.getBoundingClientRect();
      return {
        frame: frameRect ? { width: frameRect.width, height: frameRect.height } : null,
        viewport: viewportRect ? { width: viewportRect.width, height: viewportRect.height } : null,
        inlineStyleElements: globalThis.document.querySelectorAll("style").length,
      };
    });
    const primitiveResult = await page.evaluate(async () => {
      const mountRoot = globalThis.document.createElement("div");
      globalThis.document.body.append(mountRoot);
      const { mountControlledTabsSmokeFixture, mountUiSystemShowcaseFixture } =
        await import("/src/ui-system/showcase.fixture.tsx");
      const { mountAppWindowCanvasSmokeFixture } =
        await import("/src/experience/app-window-canvas.fixture.tsx");
      const dispose = mountUiSystemShowcaseFixture(mountRoot);
      const trigger = mountRoot.querySelector('[aria-label="Add pane"]');
      trigger?.focus();
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const tooltip = globalThis.document.querySelector('[role="tooltip"][data-open="true"]');
      const tooltipRect = tooltip?.getBoundingClientRect();
      const tabsRoot = globalThis.document.createElement("div");
      globalThis.document.body.append(tabsRoot);
      const controlledTabs = mountControlledTabsSmokeFixture(tabsRoot);
      controlledTabs.select("changes");
      const controlledTriggers = [...tabsRoot.querySelectorAll('[role="tab"]')];
      const controlledTabsSynchronized =
        controlledTriggers[0]?.getAttribute("aria-selected") === "false" &&
        controlledTriggers[0]?.getAttribute("tabindex") === "-1" &&
        controlledTriggers[1]?.getAttribute("aria-selected") === "true" &&
        controlledTriggers[1]?.getAttribute("tabindex") === "0";
      const canvasRoot = globalThis.document.createElement("div");
      globalThis.document.body.append(canvasRoot);
      const disposeCanvas = mountAppWindowCanvasSmokeFixture(canvasRoot);
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const docked = canvasRoot.querySelector('[data-window-id="window.docked"]');
      const floating = canvasRoot.querySelector('[data-window-id="window.floating"]');
      const canvas = canvasRoot.querySelector(".app-window-canvas");
      const canvasRect = canvas?.getBoundingClientRect();
      const dockedRect = docked?.getBoundingClientRect();
      const floatingRect = floating?.getBoundingClientRect();
      const canvasRuntimeRules = [];
      for (const sheet of globalThis.document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (
              rule instanceof globalThis.CSSStyleRule &&
              [docked, floating].some(
                (element) =>
                  element &&
                  rule.selectorText.includes(
                    element.getAttribute("data-tmi-runtime-style") ?? "__missing__",
                  ),
              )
            ) {
              canvasRuntimeRules.push(rule.cssText);
            }
          }
        } catch {
          // Ignore opaque stylesheets.
        }
      }
      const output = {
        controlledTabsSynchronized,
        portaledWithinFixture: Boolean(tooltip && mountRoot.contains(tooltip)),
        portaledWithinOverlay: Boolean(
          tooltip && trigger?.closest("[data-overlay-root]")?.contains(tooltip),
        ),
        tooltip: tooltipRect
          ? {
              left: tooltipRect.left,
              top: tooltipRect.top,
              right: tooltipRect.right,
              bottom: tooltipRect.bottom,
            }
          : null,
        canvas: {
          docked: dockedRect ? { width: dockedRect.width, height: dockedRect.height } : null,
          floating: floatingRect
            ? {
                left: floatingRect.left - (canvasRect?.left ?? 0),
                top: floatingRect.top - (canvasRect?.top ?? 0),
                width: floatingRect.width,
                height: floatingRect.height,
              }
            : null,
          runtimeKeys: [docked, floating].map((element) =>
            element?.getAttribute("data-tmi-runtime-style"),
          ),
          runtimeRules: canvasRuntimeRules,
          inlineAttributes: globalThis.document.querySelectorAll("[style]").length,
        },
      };
      disposeCanvas();
      canvasRoot.remove();
      controlledTabs.dispose();
      tabsRoot.remove();
      dispose();
      mountRoot.remove();
      return output;
    });
    const styleDiagnostics = await page.evaluate(() => {
      const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        class: element.getAttribute("class") ?? "",
        runtimeKey: element.getAttribute("data-tmi-runtime-style") ?? "",
        style: element.getAttribute("style") ?? "",
      });
      const runtimeRules = [];
      for (const sheet of globalThis.document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (
              rule instanceof globalThis.CSSStyleRule &&
              rule.selectorText.includes("data-tmi-runtime-style")
            ) {
              runtimeRules.push(rule.cssText);
            }
          }
        } catch {
          // Opaque cross-origin sheets are irrelevant to the local runtime registry.
        }
      }
      return {
        inlineAttributes: [...globalThis.document.querySelectorAll("[style]")].map(describe),
        styleElements: [...globalThis.document.querySelectorAll("style")].map(describe),
        runtimeRules,
        violations: globalThis.__tmiCspViolations ?? [],
      };
    });
    const violations = consoleMessages.filter((message) => cspViolation.test(message));
    if (violations.length > 0) {
      throw new Error(
        `Renderer emitted CSP violations:\n${violations.join("\n")}\n` +
          `Style diagnostics: ${JSON.stringify(styleDiagnostics, null, 2)}`,
      );
    }
    if (
      result.inlineStyleElements !== 0 ||
      styleDiagnostics.inlineAttributes.length !== 0 ||
      styleDiagnostics.styleElements.length !== 0
    ) {
      throw new Error(
        `Renderer created inline style nodes or attributes: ${JSON.stringify(styleDiagnostics, null, 2)}`,
      );
    }
    if (
      !result.frame ||
      result.frame.width <= 0 ||
      result.frame.height <= 0 ||
      !result.viewport ||
      result.viewport.width <= 0 ||
      result.viewport.height <= 0
    ) {
      throw new Error(`Renderer chrome has invalid geometry: ${JSON.stringify(result)}`);
    }
    if (
      !primitiveResult.portaledWithinFixture ||
      !primitiveResult.portaledWithinOverlay ||
      !primitiveResult.controlledTabsSynchronized ||
      !primitiveResult.tooltip ||
      primitiveResult.tooltip.left < 0 ||
      primitiveResult.tooltip.top < 0 ||
      primitiveResult.tooltip.right > 1_200 ||
      primitiveResult.tooltip.bottom > 800 ||
      primitiveResult.canvas.inlineAttributes !== 0 ||
      primitiveResult.canvas.runtimeKeys.some((key) => !key) ||
      primitiveResult.canvas.docked?.width !== 800 ||
      primitiveResult.canvas.docked?.height !== 500 ||
      primitiveResult.canvas.floating?.left !== 42 ||
      primitiveResult.canvas.floating?.top !== 36 ||
      primitiveResult.canvas.floating?.width !== 360 ||
      primitiveResult.canvas.floating?.height !== 220
    ) {
      throw new Error(
        `Renderer primitive tooltip escaped safe geometry: ${JSON.stringify(primitiveResult)}`,
      );
    }
  } finally {
    await browser.close();
  }
  console.log("Desktop renderer strict-CSP development smoke passed");
} finally {
  await stop(vite);
}
