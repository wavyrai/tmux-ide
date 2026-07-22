import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cspViolation = /content security policy|violates.+style-src/iu;

function cspDirectives(value) {
  return new Map(
    value.split(";").flatMap((part) => {
      const [name, ...sources] = part.trim().split(/\s+/u);
      return name ? [[name, sources.join(" ")]] : [];
    }),
  );
}

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
    const navigation = await page.goto(rendererUrl, { waitUntil: "networkidle" });
    const policy = cspDirectives(navigation?.headers()["content-security-policy"] ?? "");
    const expectedPolicy = new Map([
      ["default-src", "'self'"],
      ["script-src", "'self'"],
      ["style-src", "'self'"],
      ["style-src-elem", "'self' 'unsafe-inline'"],
      ["style-src-attr", "'unsafe-inline'"],
      ["img-src", "'self' data:"],
      ["font-src", "'self'"],
      ["connect-src", "'self' ws://127.0.0.1:5173"],
      ["object-src", "'none'"],
      ["base-uri", "'none'"],
      ["frame-ancestors", "'none'"],
      ["form-action", "'none'"],
    ]);
    if (
      policy.size !== expectedPolicy.size ||
      [...expectedPolicy].some(([directive, sources]) => policy.get(directive) !== sources)
    ) {
      throw new Error(
        `Renderer CSP boundary changed: ${JSON.stringify(Object.fromEntries(policy))}`,
      );
    }
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
      const { mountTerminalSurfaceSmokeFixture } =
        await import("/src/terminal/terminal-surface.fixture.tsx");
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
      const terminalRoot = globalThis.document.createElement("div");
      const baselineStyles = new Set(globalThis.document.querySelectorAll("style"));
      globalThis.document.body.append(terminalRoot);
      const disposeTerminal = mountTerminalSurfaceSmokeFixture(terminalRoot);
      const terminalDeadline = Date.now() + 5_000;
      let terminalSurface = null;
      while (Date.now() < terminalDeadline) {
        terminalSurface = terminalRoot.querySelector(".terminal-surface");
        if (
          terminalSurface?.getAttribute("data-phase") === "connected" &&
          terminalSurface.getAttribute("data-preserves-frame") === "true" &&
          terminalRoot.querySelector(".xterm")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const xterm = terminalRoot.querySelector(".xterm");
      const xtermRect = xterm?.getBoundingClientRect();
      const inlineStyleOwners = [...globalThis.document.querySelectorAll("[style]")].map(
        (element) => ({
          tag: element.tagName.toLowerCase(),
          class: element.getAttribute("class") ?? "",
          ownedByXterm: terminalRoot.contains(element) && Boolean(element.closest(".xterm")),
        }),
      );
      const generatedStyleOwners = [...globalThis.document.querySelectorAll("style")]
        .filter((element) => !baselineStyles.has(element))
        .map((element) => ({
          insideXterm: terminalRoot.contains(element) && Boolean(element.closest(".xterm")),
          globalXtermSheet:
            element.parentElement === globalThis.document.head &&
            element.type === "text/css" &&
            element.media === "screen",
          ruleCount: element.sheet?.cssRules.length ?? 0,
        }));
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
          inlineAttributes: canvasRoot.querySelectorAll("[style]").length,
        },
        terminal: {
          phase: terminalSurface?.getAttribute("data-phase"),
          preservesFrame: terminalSurface?.getAttribute("data-preserves-frame"),
          clientViewport: terminalSurface?.getAttribute("data-client-viewport"),
          hasXterm: Boolean(xterm),
          hasTextarea: Boolean(terminalRoot.querySelector(".xterm-helper-textarea")),
          hasCursor: Boolean(terminalRoot.querySelector(".xterm-cursor")),
          renderedText: terminalRoot.textContent?.includes("CSP terminal ready") ?? false,
          geometry: xtermRect ? { width: xtermRect.width, height: xtermRect.height } : null,
          inlineStyleOwners,
          generatedStyleOwners,
        },
      };
      disposeTerminal();
      terminalRoot.remove();
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
    if (violations.length > 0 || styleDiagnostics.violations.length > 0) {
      throw new Error(
        `Renderer emitted CSP violations:\n${violations.join("\n")}\n` +
          `Style diagnostics: ${JSON.stringify(styleDiagnostics, null, 2)}`,
      );
    }
    if (
      result.inlineStyleElements !== 0 ||
      styleDiagnostics.inlineAttributes.length !== 0 ||
      styleDiagnostics.styleElements.some(
        (element) => element.tag !== "style" || element.style !== "",
      )
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
      primitiveResult.canvas.floating?.height !== 220 ||
      primitiveResult.terminal.phase !== "connected" ||
      primitiveResult.terminal.preservesFrame !== "true" ||
      !primitiveResult.terminal.hasXterm ||
      !primitiveResult.terminal.hasTextarea ||
      !primitiveResult.terminal.hasCursor ||
      !primitiveResult.terminal.renderedText ||
      !primitiveResult.terminal.geometry ||
      primitiveResult.terminal.geometry.width <= 0 ||
      primitiveResult.terminal.geometry.height <= 0 ||
      primitiveResult.terminal.inlineStyleOwners.length === 0 ||
      primitiveResult.terminal.inlineStyleOwners.some((owner) => !owner.ownedByXterm) ||
      primitiveResult.terminal.generatedStyleOwners.length === 0 ||
      primitiveResult.terminal.generatedStyleOwners.some(
        (owner) => !owner.insideXterm && !owner.globalXtermSheet,
      )
    ) {
      throw new Error(
        `Renderer primitive, canvas, or xterm boundary failed: ${JSON.stringify(primitiveResult)}`,
      );
    }

    const visualPage = await browser.newPage({
      viewport: { width: 1_440, height: 900 },
      colorScheme: "dark",
    });
    const visualConsoleMessages = [];
    visualPage.on("console", (message) => visualConsoleMessages.push(message.text()));
    await visualPage.addInitScript(() => {
      globalThis.__tmiCspViolations = [];
      globalThis.document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__tmiCspViolations.push({
          blockedURI: event.blockedURI,
          directive: event.effectiveDirective,
        });
      });
    });
    await visualPage.goto(rendererUrl, { waitUntil: "networkidle" });
    const visualResult = await visualPage.evaluate(async () => {
      const oldRoot = globalThis.document.getElementById("root");
      oldRoot?.remove();
      const root = globalThis.document.createElement("div");
      root.id = "root";
      globalThis.document.body.append(root);
      const { mountDesktopCanvasFirstRunFixture } =
        await import("/src/experience/desktop-canvas-first-run.fixture.tsx");
      mountDesktopCanvasFirstRunFixture(root);
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const rect = (selector) => {
        const bounds = globalThis.document.querySelector(selector)?.getBoundingClientRect();
        return bounds
          ? {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              right: bounds.right,
              bottom: bounds.bottom,
            }
          : null;
      };
      const canvas = rect(".app-window-canvas");
      const cards = [...globalThis.document.querySelectorAll(".app-window-card")].map((card) => {
        const bounds = card.getBoundingClientRect();
        return {
          placement: card.getAttribute("data-placement"),
          left: bounds.left - (canvas?.left ?? 0),
          top: bounds.top - (canvas?.top ?? 0),
          width: bounds.width,
          height: bounds.height,
        };
      });
      const canvasElement = globalThis.document.querySelector(".app-window-canvas");
      const terminalElement = globalThis.document.querySelector(
        '.app-window-card[data-selected="true"] .terminal-surface',
      );
      const initialScale = Number(canvasElement?.getAttribute("data-viewport-scale"));
      terminalElement?.dispatchEvent(
        new globalThis.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -40,
        }),
      );
      const scaleAfterTerminalWheel = Number(canvasElement?.getAttribute("data-viewport-scale"));
      canvasElement?.dispatchEvent(
        new globalThis.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          clientX: 720,
          clientY: 420,
          deltaY: -40,
        }),
      );
      const scaleAfterCanvasPinch = Number(canvasElement?.getAttribute("data-viewport-scale"));
      canvasElement?.dispatchEvent(
        new globalThis.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 64,
          deltaY: 36,
        }),
      );
      const selectedCard = globalThis.document.querySelector(
        '.app-window-card[data-selected="true"]',
      );
      const maximizeControl = selectedCard?.querySelector('[data-action-id="app-window-maximize"]');
      const closeControl = selectedCard?.querySelector('[data-action-id="app-window-close"]');
      maximizeControl?.dispatchEvent(
        new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }),
      );
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const maximizedCardRect = selectedCard?.getBoundingClientRect();
      const currentCanvasRect = canvasElement?.getBoundingClientRect();
      const maximizedGeometry =
        maximizedCardRect && currentCanvasRect
          ? {
              left: maximizedCardRect.left - currentCanvasRect.left,
              top: maximizedCardRect.top - currentCanvasRect.top,
              right: maximizedCardRect.right - currentCanvasRect.left,
              bottom: maximizedCardRect.bottom - currentCanvasRect.top,
              canvasWidth: currentCanvasRect.width,
              canvasHeight: currentCanvasRect.height,
              canvasClientLeft: canvasElement.clientLeft,
              canvasClientTop: canvasElement.clientTop,
              canvasClientWidth: canvasElement.clientWidth,
              canvasClientHeight: canvasElement.clientHeight,
            }
          : null;
      const maximizedByMouse =
        selectedCard?.getAttribute("data-maximized") === "true" &&
        maximizeControl?.getAttribute("aria-pressed") === "true";
      maximizeControl?.dispatchEvent(
        new globalThis.MouseEvent("click", { bubbles: true, detail: 0 }),
      );
      const restoredByKeyboard =
        selectedCard?.getAttribute("data-maximized") === "false" &&
        maximizeControl?.getAttribute("aria-pressed") === "false";
      globalThis.document.querySelector('[aria-label="Reset view"]')?.click();
      const scaleAfterReset = Number(canvasElement?.getAttribute("data-viewport-scale"));
      return {
        app: rect(".app"),
        titlebar: rect(".titlebar"),
        sidebar: rect(".workspace-sidebar"),
        canvas,
        cards,
        dock: rect(".workspace-dock"),
        status: rect(".status-strip"),
        tabs: globalThis.document.querySelectorAll(".primary-tabs [role=tab]").length,
        dockTabs: globalThis.document.querySelectorAll(".workbench-dock__tab").length,
        styleAttributes: globalThis.document.querySelectorAll("[style]").length,
        styleElements: globalThis.document.querySelectorAll("style").length,
        viewportInput: {
          initialScale,
          scaleAfterTerminalWheel,
          scaleAfterCanvasPinch,
          scaleAfterReset,
        },
        windowControls: {
          maximizedByMouse,
          restoredByKeyboard,
          maximizedGeometry,
          closeDisabled:
            closeControl?.hasAttribute("disabled") === true &&
            closeControl.getAttribute("title")?.includes("not supported") === true,
        },
        violations: globalThis.__tmiCspViolations ?? [],
      };
    });
    const activeCard = visualPage.locator('.app-window-card[data-selected="true"]');
    const terminalViewport = activeCard.locator(".terminal-surface__viewport");
    await terminalViewport.evaluate((element) => {
      element.setAttribute("data-canvas-smoke-identity", "stable");
    });
    const beforeDrag = await activeCard.boundingBox();
    const header = await activeCard.locator(".web-pane-frame__title").boundingBox();
    if (!beforeDrag || !header) throw new Error("Desktop canvas drag target is unavailable");
    await visualPage.mouse.move(
      header.x + Math.min(40, header.width / 2),
      header.y + header.height / 2,
    );
    await visualPage.mouse.down();
    await visualPage.mouse.move(
      header.x + Math.min(40, header.width / 2) + 72,
      header.y + header.height / 2 + 48,
      { steps: 4 },
    );
    await visualPage.mouse.up();
    const afterDrag = await activeCard.boundingBox();
    const dragResult = {
      deltaX: afterDrag ? Math.round(afterDrag.x - beforeDrag.x) : null,
      deltaY: afterDrag ? Math.round(afterDrag.y - beforeDrag.y) : null,
      terminalIdentityStable:
        (await terminalViewport.getAttribute("data-canvas-smoke-identity")) === "stable",
      styleAttributes: await visualPage.locator("[style]").count(),
    };
    if (process.env.TMUX_IDE_DESKTOP_VISUAL_SCREENSHOT) {
      await visualPage.screenshot({
        path: process.env.TMUX_IDE_DESKTOP_VISUAL_SCREENSHOT,
        fullPage: true,
      });
    }
    await visualPage.close();
    const visualViolations = visualConsoleMessages.filter((message) => cspViolation.test(message));
    const [frontCard] = visualResult.cards.slice(-1);
    if (
      visualViolations.length > 0 ||
      visualResult.violations.some(({ directive }) => directive.startsWith("style-src")) ||
      visualResult.styleAttributes !== 0 ||
      visualResult.styleElements !== 0 ||
      visualResult.viewportInput.initialScale !== 1 ||
      visualResult.viewportInput.scaleAfterTerminalWheel !== 1 ||
      visualResult.viewportInput.scaleAfterCanvasPinch <= 1 ||
      visualResult.viewportInput.scaleAfterReset !== 1 ||
      !visualResult.windowControls.maximizedByMouse ||
      !visualResult.windowControls.restoredByKeyboard ||
      !visualResult.windowControls.maximizedGeometry ||
      Math.abs(
        visualResult.windowControls.maximizedGeometry.left -
          (visualResult.windowControls.maximizedGeometry.canvasClientLeft + 12),
      ) > 0.5 ||
      Math.abs(
        visualResult.windowControls.maximizedGeometry.top -
          (visualResult.windowControls.maximizedGeometry.canvasClientTop + 12),
      ) > 0.5 ||
      Math.abs(
        visualResult.windowControls.maximizedGeometry.right -
          (visualResult.windowControls.maximizedGeometry.canvasClientLeft +
            visualResult.windowControls.maximizedGeometry.canvasClientWidth -
            12),
      ) > 0.5 ||
      Math.abs(
        visualResult.windowControls.maximizedGeometry.bottom -
          (visualResult.windowControls.maximizedGeometry.canvasClientTop +
            visualResult.windowControls.maximizedGeometry.canvasClientHeight -
            12),
      ) > 0.5 ||
      !visualResult.windowControls.closeDisabled ||
      dragResult.deltaX !== 72 ||
      dragResult.deltaY !== 48 ||
      !dragResult.terminalIdentityStable ||
      dragResult.styleAttributes !== 0 ||
      visualResult.app?.width !== 1_440 ||
      visualResult.app?.height !== 900 ||
      visualResult.titlebar?.height !== 50 ||
      visualResult.sidebar?.width !== 236 ||
      visualResult.dock?.height !== 40 ||
      visualResult.status?.height !== 22 ||
      visualResult.tabs !== 2 ||
      visualResult.dockTabs !== 4 ||
      visualResult.cards.length !== 2 ||
      visualResult.cards.some(
        (card) => card.placement !== "floating" || card.width !== 840 || card.height !== 520,
      ) ||
      !visualResult.canvas ||
      !frontCard ||
      frontCard.left <= 0 ||
      frontCard.top <= 0 ||
      frontCard.left + frontCard.width >= visualResult.canvas.width ||
      frontCard.top + frontCard.height >= visualResult.canvas.height
    ) {
      throw new Error(
        `Desktop first-run canvas visual acceptance failed: ${JSON.stringify(visualResult, null, 2)}\n` +
          `Interaction result: ${JSON.stringify(dragResult, null, 2)}\n` +
          visualViolations.join("\n"),
      );
    }

    const shellEvidenceCases = [
      { appearance: "dark", width: 1_440, height: 900 },
      { appearance: "light", width: 1_440, height: 900 },
      { appearance: "dark", width: 1_200, height: 800 },
      { appearance: "light", width: 1_200, height: 800 },
      { appearance: "dark", width: 840, height: 620 },
      { appearance: "light", width: 840, height: 620 },
    ];
    const shellEvidence = [];
    for (const fixture of shellEvidenceCases) {
      const evidencePage = await browser.newPage({
        viewport: { width: fixture.width, height: fixture.height },
        colorScheme: fixture.appearance,
      });
      const evidenceConsoleMessages = [];
      evidencePage.on("console", (message) => evidenceConsoleMessages.push(message.text()));
      await evidencePage.addInitScript(() => {
        globalThis.__tmiCspViolations = [];
        globalThis.document.addEventListener("securitypolicyviolation", (event) => {
          globalThis.__tmiCspViolations.push({
            blockedURI: event.blockedURI,
            directive: event.effectiveDirective,
          });
        });
      });
      await evidencePage.goto(rendererUrl, { waitUntil: "networkidle" });
      const evidence = await evidencePage.evaluate(async ({ appearance, width, height }) => {
        globalThis.document.getElementById("root")?.remove();
        const root = globalThis.document.createElement("div");
        root.id = "root";
        globalThis.document.body.append(root);
        const { mountDesktopCanvasFirstRunFixture } =
          await import("/src/experience/desktop-canvas-first-run.fixture.tsx");
        mountDesktopCanvasFirstRunFixture(root, appearance);
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const dimensions = (selector) => {
          const bounds = globalThis.document.querySelector(selector)?.getBoundingClientRect();
          return bounds ? { width: bounds.width, height: bounds.height } : null;
        };
        const layoutBounds = () => {
          const read = (selector) => {
            const bounds = globalThis.document.querySelector(selector)?.getBoundingClientRect();
            return bounds
              ? {
                  left: bounds.left,
                  top: bounds.top,
                  right: bounds.right,
                  bottom: bounds.bottom,
                  width: bounds.width,
                  height: bounds.height,
                }
              : null;
          };
          return {
            main: read(".workspace-main"),
            sidebar: read(".workspace-sidebar"),
            canvas: read(".workspace-canvas:not([hidden])"),
            dock: read(".workspace-dock"),
          };
        };
        const computed = (selector) => {
          const element = globalThis.document.querySelector(selector);
          return element ? globalThis.getComputedStyle(element) : null;
        };
        const titlebarStyle = computed(".titlebar");
        const initial = {
          app: dimensions(".app"),
          titlebar: dimensions(".titlebar"),
          sidebar: dimensions(".workspace-sidebar"),
          dock: dimensions(".workspace-dock"),
          status: dimensions(".status-strip"),
          primaryTab: dimensions('.primary-tabs [role="tab"]'),
          palette: dimensions(".palette-trigger"),
          sidebarRow: dimensions(".sidebar-row"),
          icon: dimensions('.primary-tabs [role="tab"] svg'),
        };
        const paletteTrigger = globalThis.document.querySelector(
          "#application-command-palette-trigger",
        );
        paletteTrigger?.focus();
        globalThis.document.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const keyboardOverlay = globalThis.document.querySelector(".command-palette-overlay");
        const keyboardPalette = globalThis.document.querySelector(".command-palette");
        const paletteInput = globalThis.document.querySelector('[role="combobox"]');
        const keyboardPaletteBounds = keyboardPalette?.getBoundingClientRect();
        const paletteBounds = keyboardPaletteBounds
          ? {
              width: keyboardPaletteBounds.width,
              height: keyboardPaletteBounds.height,
              left: keyboardPaletteBounds.left,
              right: keyboardPaletteBounds.right,
              bottom: keyboardPaletteBounds.bottom,
            }
          : null;
        const keyboardOverlayDuration = keyboardOverlay
          ? globalThis.getComputedStyle(keyboardOverlay).transitionDuration
          : null;
        const keyboardPaletteDuration = keyboardPalette
          ? globalThis.getComputedStyle(keyboardPalette).transitionDuration
          : null;
        if (paletteInput instanceof globalThis.HTMLInputElement) {
          paletteInput.value = "nothing-matches-this";
          paletteInput.dispatchEvent(new globalThis.InputEvent("input", { bubbles: true }));
        }
        const emptyText = globalThis.document.querySelector(".command-palette__empty")?.textContent;
        paletteInput?.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const keyboardFocusReturned = globalThis.document.activeElement === paletteTrigger;
        paletteTrigger?.dispatchEvent(
          new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }),
        );
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const pointerOverlay = globalThis.document.querySelector(".command-palette-overlay");
        const pointerPalette = globalThis.document.querySelector(".command-palette");
        const pointerOpen = {
          source: pointerOverlay?.getAttribute("data-transition-source") ?? null,
          overlayDuration: pointerOverlay
            ? globalThis.getComputedStyle(pointerOverlay).transitionDuration
            : null,
          paletteDuration: pointerPalette
            ? globalThis.getComputedStyle(pointerPalette).transitionDuration
            : null,
        };
        const appElement = globalThis.document.querySelector(".app");
        const previousReducedMotion = appElement?.getAttribute("data-reduced-motion") ?? null;
        appElement?.setAttribute("data-reduced-motion", "true");
        const reducedMotion = {
          overlayDuration: pointerOverlay
            ? globalThis.getComputedStyle(pointerOverlay).transitionDuration
            : null,
          paletteDuration: pointerPalette
            ? globalThis.getComputedStyle(pointerPalette).transitionDuration
            : null,
        };
        if (previousReducedMotion === null) appElement?.removeAttribute("data-reduced-motion");
        else appElement?.setAttribute("data-reduced-motion", previousReducedMotion);
        pointerOverlay?.dispatchEvent(
          new globalThis.MouseEvent("mousedown", { bubbles: true, detail: 1 }),
        );
        const pointerClose = {
          source: pointerOverlay?.getAttribute("data-transition-source") ?? null,
          state: pointerOverlay?.getAttribute("data-state") ?? null,
          overlayDuration: pointerOverlay
            ? globalThis.getComputedStyle(pointerOverlay).transitionDuration
            : null,
          paletteDuration: pointerPalette
            ? globalThis.getComputedStyle(pointerPalette).transitionDuration
            : null,
        };
        paletteTrigger?.dispatchEvent(
          new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }),
        );
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const paletteEvidence = {
          source: keyboardOverlay?.getAttribute("data-transition-source") ?? null,
          state: keyboardOverlay?.getAttribute("data-state") ?? null,
          groups: globalThis.document.querySelectorAll('.command-palette__group[role="group"]')
            .length,
          options: globalThis.document.querySelectorAll('.command-palette__option[role="option"]')
            .length,
          icons: globalThis.document.querySelectorAll(".command-palette__option svg").length,
          shortcuts: globalThis.document.querySelectorAll(".command-palette__option kbd").length,
          width: paletteBounds?.width ?? null,
          height: paletteBounds?.height ?? null,
          left: paletteBounds?.left ?? null,
          right: paletteBounds?.right ?? null,
          bottom: paletteBounds?.bottom ?? null,
          keyboardOverlayDuration,
          keyboardPaletteDuration,
          keyboardFocusReturned,
          emptyText: emptyText ?? null,
          pointerOpen,
          pointerClose,
          reducedMotion,
        };
        pointerOverlay?.dispatchEvent(
          new globalThis.MouseEvent("mousedown", { bubbles: true, detail: 1 }),
        );
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        globalThis.document
          .querySelector('[data-action="toggle-collapse"]')
          ?.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const openDock = layoutBounds();
        globalThis.document
          .querySelector('[data-action="toggle-collapse"]')
          ?.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const collapsedDock = layoutBounds();
        globalThis.document
          .querySelector('[data-action="toggle-collapse"]')
          ?.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        globalThis.document
          .querySelector('[data-action="toggle-maximize"]')
          ?.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const maximizedDock = layoutBounds();
        globalThis.document
          .querySelector('[data-action="toggle-maximize"]')
          ?.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const restoredDock = layoutBounds();
        let interaction = null;
        if (width === 840) {
          globalThis.document
            .querySelector('[aria-label="Collapse sidebar"]')
            ?.dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }));
          await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
          const collapsed = layoutBounds();
          globalThis.document.dispatchEvent(
            new globalThis.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
          );
          await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
          const resizeHandle = globalThis.document.querySelector(
            '.workspace-sidebar__resize[role="separator"]',
          );
          resizeHandle?.dispatchEvent(
            new globalThis.KeyboardEvent("keydown", { key: "End", bubbles: true }),
          );
          await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
          interaction = {
            collapsed,
            resized: layoutBounds(),
            resizeValue: resizeHandle?.getAttribute("aria-valuenow") ?? null,
          };
        }
        paletteTrigger?.dispatchEvent(
          new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }),
        );
        await new Promise((resolve) => setTimeout(resolve, 180));
        return {
          appearance,
          viewport: { width, height },
          ...initial,
          resizeHandle: Boolean(
            globalThis.document.querySelector('.workspace-sidebar__resize[role="separator"]'),
          ),
          chromeColor: titlebarStyle?.backgroundColor ?? null,
          horizontalOverflow: globalThis.document.documentElement.scrollWidth > width,
          verticalOverflow: globalThis.document.documentElement.scrollHeight > height,
          styleAttributes: globalThis.document.querySelectorAll("[style]").length,
          styleElements: globalThis.document.querySelectorAll("style").length,
          violations: globalThis.__tmiCspViolations ?? [],
          paletteEvidence,
          dockModes: {
            open: openDock,
            collapsed: collapsedDock,
            maximized: maximizedDock,
            restored: restoredDock,
          },
          interaction,
        };
      }, fixture);
      shellEvidence.push({
        ...evidence,
        consoleViolations: evidenceConsoleMessages.filter((message) => cspViolation.test(message)),
      });
      if (process.env.TMUX_IDE_DESKTOP_VISUAL_SCREENSHOT) {
        const evidencePath = process.env.TMUX_IDE_DESKTOP_VISUAL_SCREENSHOT.replace(
          /(\.[^.]+)$/u,
          `-${fixture.appearance}-${fixture.width}x${fixture.height}$1`,
        );
        await evidencePage.screenshot({ path: evidencePath, fullPage: true });
      }
      await evidencePage.close();
    }
    const darkEvidence = shellEvidence.find(
      (evidence) => evidence.appearance === "dark" && evidence.viewport.width === 1_200,
    );
    const lightEvidence = shellEvidence.find(
      (evidence) => evidence.appearance === "light" && evidence.viewport.width === 1_200,
    );
    const dockGeometryIsValid = (evidence) => {
      const { open, collapsed, maximized, restored } = evidence.dockModes;
      const aligned = (layout) =>
        layout.main &&
        layout.canvas &&
        layout.dock &&
        Math.abs(layout.canvas.bottom - layout.dock.top) < 0.5 &&
        Math.abs(layout.dock.bottom - layout.main.bottom) < 0.5 &&
        Math.abs(layout.dock.left - layout.main.left) < 0.5 &&
        Math.abs(layout.dock.width - layout.main.width) < 0.5;
      return (
        aligned(open) &&
        aligned(collapsed) &&
        aligned(maximized) &&
        aligned(restored) &&
        Math.abs(collapsed.dock.height - 40) < 0.5 &&
        Math.abs(maximized.canvas.height) < 0.5 &&
        Math.abs(maximized.dock.height - maximized.main.height) < 0.5 &&
        Math.abs(open.canvas.height - restored.canvas.height) < 0.5 &&
        Math.abs(open.dock.height - restored.dock.height) < 0.5
      );
    };
    if (
      shellEvidence.some(
        (evidence) =>
          evidence.app?.width !== evidence.viewport.width ||
          evidence.app?.height !== evidence.viewport.height ||
          evidence.titlebar?.height !== 50 ||
          evidence.sidebar?.width !== 236 ||
          evidence.dock?.height !== 40 ||
          evidence.status?.height !== 22 ||
          evidence.primaryTab?.height !== 36 ||
          evidence.palette?.height !== 32 ||
          (evidence.sidebarRow?.height ?? 0) < 40 ||
          evidence.icon?.width !== 16 ||
          !evidence.resizeHandle ||
          evidence.horizontalOverflow ||
          evidence.verticalOverflow ||
          !dockGeometryIsValid(evidence) ||
          evidence.styleAttributes !== 0 ||
          evidence.styleElements !== 0 ||
          evidence.violations.some(({ directive }) => directive.startsWith("style-src")) ||
          evidence.consoleViolations.length > 0 ||
          evidence.paletteEvidence.groups !== 2 ||
          evidence.paletteEvidence.options !== 6 ||
          evidence.paletteEvidence.icons !== 6 ||
          evidence.paletteEvidence.shortcuts !== 6 ||
          !evidence.paletteEvidence.width ||
          evidence.paletteEvidence.width > 680 ||
          !evidence.paletteEvidence.height ||
          evidence.paletteEvidence.left < 0 ||
          evidence.paletteEvidence.right > evidence.viewport.width ||
          evidence.paletteEvidence.bottom > evidence.viewport.height ||
          evidence.paletteEvidence.keyboardOverlayDuration !== "0s" ||
          evidence.paletteEvidence.keyboardPaletteDuration !== "0s" ||
          !evidence.paletteEvidence.keyboardFocusReturned ||
          !evidence.paletteEvidence.emptyText?.includes("No commands found") ||
          evidence.paletteEvidence.pointerOpen.source !== "mouse" ||
          evidence.paletteEvidence.pointerOpen.overlayDuration !== "0.15s, 0s" ||
          evidence.paletteEvidence.pointerOpen.paletteDuration !== "0.15s, 0.15s" ||
          evidence.paletteEvidence.pointerClose.source !== "mouse" ||
          evidence.paletteEvidence.pointerClose.state !== "closed" ||
          evidence.paletteEvidence.pointerClose.overlayDuration !== "0.1s, 0s" ||
          evidence.paletteEvidence.pointerClose.paletteDuration !== "0.1s, 0.1s" ||
          evidence.paletteEvidence.reducedMotion.overlayDuration !== "0s" ||
          evidence.paletteEvidence.reducedMotion.paletteDuration !== "0s",
      ) ||
      !darkEvidence?.chromeColor ||
      !lightEvidence?.chromeColor ||
      darkEvidence.chromeColor === lightEvidence.chromeColor ||
      shellEvidence.some(
        (evidence) =>
          evidence.interaction &&
          (evidence.interaction.collapsed.sidebar?.width !== 48 ||
            evidence.interaction.collapsed.dock?.left !== 48 ||
            (evidence.interaction.collapsed.canvas?.left ?? 0) < 48 ||
            evidence.interaction.resized.sidebar?.width !== 300 ||
            evidence.interaction.resized.dock?.left !== 300 ||
            (evidence.interaction.resized.canvas?.left ?? 0) < 300 ||
            evidence.interaction.resizeValue !== "300"),
      )
    ) {
      throw new Error(
        `Desktop shell responsive/theme evidence failed: ${JSON.stringify(shellEvidence, null, 2)}`,
      );
    }

    const journeyEvidenceCases = [
      { mode: "missions", appearance: "dark", width: 1_440, height: 900 },
      { mode: "missions", appearance: "light", width: 1_440, height: 900 },
      { mode: "activity", appearance: "dark", width: 1_440, height: 900 },
      { mode: "activity", appearance: "light", width: 1_440, height: 900 },
      { mode: "missions", appearance: "dark", width: 1_200, height: 800 },
      { mode: "missions", appearance: "light", width: 1_200, height: 800 },
      { mode: "activity", appearance: "dark", width: 1_200, height: 800 },
      { mode: "activity", appearance: "light", width: 1_200, height: 800 },
      { mode: "missions", appearance: "dark", width: 840, height: 620 },
      { mode: "missions", appearance: "light", width: 840, height: 620 },
      { mode: "activity", appearance: "dark", width: 840, height: 620 },
      { mode: "activity", appearance: "light", width: 840, height: 620 },
    ];
    const journeyEvidence = [];
    for (const fixture of journeyEvidenceCases) {
      const evidencePage = await browser.newPage({
        viewport: { width: fixture.width, height: fixture.height },
        colorScheme: fixture.appearance,
      });
      const evidenceConsoleMessages = [];
      evidencePage.on("console", (message) => evidenceConsoleMessages.push(message.text()));
      await evidencePage.addInitScript(() => {
        globalThis.__tmiCspViolations = [];
        globalThis.document.addEventListener("securitypolicyviolation", (event) => {
          globalThis.__tmiCspViolations.push({
            blockedURI: event.blockedURI,
            directive: event.effectiveDirective,
          });
        });
      });
      await evidencePage.goto(rendererUrl, { waitUntil: "networkidle" });
      const evidence = await evidencePage.evaluate(async ({ mode, appearance, width, height }) => {
        globalThis.document.getElementById("root")?.remove();
        const root = globalThis.document.createElement("div");
        root.id = "root";
        globalThis.document.body.append(root);
        const { mountMissionActivityShellFixture } =
          await import("/src/experience/mission-activity-shell.fixture.tsx");
        mountMissionActivityShellFixture(root, mode, appearance);
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const bounds = (selector) => {
          const rect = globalThis.document.querySelector(selector)?.getBoundingClientRect();
          return rect
            ? {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              }
            : null;
        };
        const genericHeader = globalThis.document.querySelector(
          ".dock-surface__content--journey > header",
        );
        const detailTime = globalThis.document.querySelector(
          ".mission-journey__detail > header time",
        );
        const selectedTerminalTab = globalThis.document.querySelector(
          '.primary-tabs [role="tab"][aria-selected="true"]',
        );
        const statusConnection = globalThis.document.querySelector(".status-strip__connection");
        const initial = {
          app: bounds(".app"),
          main: bounds(".workspace-main"),
          dock: bounds(".workspace-dock"),
          journey: bounds(".mission-journey"),
          list: bounds(".mission-journey__list-region"),
          detail: bounds(".mission-journey__detail"),
          toolbarCount: globalThis.document.querySelectorAll(".mission-journey__toolbar").length,
          genericHeaderDisplay: genericHeader
            ? globalThis.getComputedStyle(genericHeader).display
            : null,
          detailTimeWhiteSpace: detailTime
            ? globalThis.getComputedStyle(detailTime).whiteSpace
            : null,
          detailMetadataSize: detailTime
            ? Number.parseFloat(globalThis.getComputedStyle(detailTime).fontSize)
            : null,
          selectedTerminalLabel: selectedTerminalTab?.textContent?.trim() ?? null,
          dockMode: globalThis.document
            .querySelector(".workspace-main")
            ?.getAttribute("data-dock-mode"),
          connectionState: statusConnection?.getAttribute("data-state") ?? null,
          connectionText: statusConnection?.textContent?.trim() ?? null,
          returnControl: Boolean(
            [...globalThis.document.querySelectorAll("button")].find((button) =>
              button.textContent?.includes("Return to terminals"),
            ),
          ),
          timeline: Boolean(
            globalThis.document.querySelector(
              mode === "missions"
                ? '[aria-label="Mission timeline"]'
                : '[aria-label="Recent durable activity"]',
            ),
          ),
          horizontalOverflow: globalThis.document.documentElement.scrollWidth > width,
          verticalOverflow: globalThis.document.documentElement.scrollHeight > height,
          styleAttributes: globalThis.document.querySelectorAll("[style]").length,
          styleElements: globalThis.document.querySelectorAll("style").length,
          violations: globalThis.__tmiCspViolations ?? [],
        };
        const returnControl = [...globalThis.document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Return to terminals"),
        );
        returnControl?.dispatchEvent(
          new globalThis.MouseEvent("click", { bubbles: true, detail: 1 }),
        );
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        return {
          mode,
          appearance,
          viewport: { width, height },
          ...initial,
          returned: {
            dockMode: globalThis.document
              .querySelector(".workspace-main")
              ?.getAttribute("data-dock-mode"),
            selectedTerminalLabel:
              globalThis.document
                .querySelector('.primary-tabs [role="tab"][aria-selected="true"]')
                ?.textContent?.trim() ?? null,
          },
        };
      }, fixture);
      journeyEvidence.push({
        ...evidence,
        consoleViolations: evidenceConsoleMessages.filter((message) => cspViolation.test(message)),
      });
      if (process.env.TMUX_IDE_DESKTOP_VISUAL_SCREENSHOT) {
        const evidencePath = process.env.TMUX_IDE_DESKTOP_VISUAL_SCREENSHOT.replace(
          /(\.[^.]+)$/u,
          `-${fixture.mode}-${fixture.appearance}-${fixture.width}x${fixture.height}$1`,
        );
        await evidencePage.screenshot({ path: evidencePath, fullPage: true });
      }
      await evidencePage.close();
    }
    if (
      journeyEvidence.some(
        (evidence) =>
          evidence.app?.width !== evidence.viewport.width ||
          evidence.app?.height !== evidence.viewport.height ||
          !evidence.main ||
          !evidence.dock ||
          !evidence.journey ||
          !evidence.list ||
          !evidence.detail ||
          Math.abs(evidence.dock.bottom - evidence.main.bottom) > 0.5 ||
          Math.abs(evidence.journey.bottom - evidence.dock.bottom) > 0.5 ||
          evidence.toolbarCount !== 0 ||
          evidence.genericHeaderDisplay !== "none" ||
          evidence.detailTimeWhiteSpace !== "nowrap" ||
          (evidence.detailMetadataSize ?? 0) < 11 ||
          !evidence.selectedTerminalLabel?.includes("Terminals") ||
          evidence.dockMode !== "maximized" ||
          evidence.connectionState !== "connected" ||
          !evidence.connectionText?.includes("Native tmux workspace connected") ||
          !evidence.returnControl ||
          !evidence.timeline ||
          evidence.horizontalOverflow ||
          evidence.verticalOverflow ||
          evidence.styleAttributes !== 0 ||
          evidence.styleElements !== 0 ||
          evidence.violations.some(({ directive }) => directive.startsWith("style-src")) ||
          evidence.consoleViolations.length > 0 ||
          evidence.returned.dockMode !== "collapsed" ||
          !evidence.returned.selectedTerminalLabel?.includes("Terminals"),
      )
    ) {
      throw new Error(
        `Desktop mission/activity visual acceptance failed: ${JSON.stringify(journeyEvidence, null, 2)}`,
      );
    }

    const workspaceSurfacePage = await browser.newPage({
      viewport: { width: 1_440, height: 900 },
      colorScheme: "dark",
    });
    const workspaceSurfaceConsole = [];
    workspaceSurfacePage.on("console", (message) => workspaceSurfaceConsole.push(message.text()));
    await workspaceSurfacePage.addInitScript(() => {
      globalThis.__tmiCspViolations = [];
      globalThis.document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__tmiCspViolations.push({
          blockedURI: event.blockedURI,
          directive: event.effectiveDirective,
        });
      });
    });
    await workspaceSurfacePage.goto(rendererUrl, { waitUntil: "networkidle" });
    const workspaceSurfaceEvidence = await workspaceSurfacePage.evaluate(async () => {
      globalThis.document.getElementById("root")?.remove();
      const filesRoot = globalThis.document.createElement("div");
      filesRoot.id = "root";
      globalThis.document.body.append(filesRoot);
      const { mountWorkspaceFilesShellFixture } =
        await import("/src/experience/workspace-files-surface.fixture.tsx");
      const disposeFiles = mountWorkspaceFilesShellFixture(filesRoot, "ready-preview", "dark");
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const treeRows = filesRoot.querySelectorAll('.workspace-files__row[role="treeitem"]').length;
      const previewLines = filesRoot.querySelectorAll(".workspace-files__code li").length;
      const selectedFile = filesRoot.querySelector('.workspace-files__row[aria-selected="true"]');
      const gitGlyph = filesRoot.querySelector(".workspace-files__git");
      disposeFiles();
      filesRoot.remove();

      const changesRoot = globalThis.document.createElement("div");
      changesRoot.id = "root";
      globalThis.document.body.append(changesRoot);
      const { mountWorkspaceChangesShellFixture } =
        await import("/src/experience/workspace-changes-surface.fixture.tsx");
      const disposeChanges = mountWorkspaceChangesShellFixture(changesRoot, "ready-diff", "dark");
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const changeRows = changesRoot.querySelectorAll(
        '.workspace-changes__row[role="option"]',
      ).length;
      const hunks = changesRoot.querySelectorAll(".workspace-changes__hunk").length;
      const diffLines = changesRoot.querySelectorAll(".workspace-changes__line").length;
      const insertLine = changesRoot.querySelector('.workspace-changes__line[data-kind="insert"]');
      disposeChanges();
      changesRoot.remove();

      return {
        treeRows,
        previewLines,
        selectedFile: selectedFile?.querySelector(".workspace-files__name")?.textContent ?? null,
        gitGlyph: gitGlyph?.textContent ?? null,
        changeRows,
        hunks,
        diffLines,
        insertLine: insertLine?.querySelector("code")?.textContent ?? null,
        styleAttributes: globalThis.document.querySelectorAll("[style]").length,
        styleElements: globalThis.document.querySelectorAll("style").length,
        violations: globalThis.__tmiCspViolations ?? [],
      };
    });
    await workspaceSurfacePage.close();
    const workspaceSurfaceViolations = workspaceSurfaceConsole.filter((message) =>
      cspViolation.test(message),
    );
    if (
      workspaceSurfaceViolations.length > 0 ||
      workspaceSurfaceEvidence.violations.some(({ directive }) =>
        directive.startsWith("style-src"),
      ) ||
      workspaceSurfaceEvidence.styleAttributes !== 0 ||
      workspaceSurfaceEvidence.styleElements !== 0 ||
      workspaceSurfaceEvidence.treeRows < 3 ||
      workspaceSurfaceEvidence.previewLines < 1 ||
      !workspaceSurfaceEvidence.selectedFile ||
      workspaceSurfaceEvidence.changeRows < 1 ||
      workspaceSurfaceEvidence.hunks < 1 ||
      workspaceSurfaceEvidence.diffLines < 1 ||
      !workspaceSurfaceEvidence.insertLine
    ) {
      throw new Error(
        `Desktop Files/Changes surface acceptance failed: ${JSON.stringify(
          { ...workspaceSurfaceEvidence, workspaceSurfaceViolations },
          null,
          2,
        )}`,
      );
    }
  } finally {
    await browser.close();
  }
  console.log("Desktop renderer strict-CSP development smoke passed");
} finally {
  await stop(vite);
}
