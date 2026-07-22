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
    "No Chromium browser found. Set TMUX_IDE_CHROMIUM_EXECUTABLE to run the strict-CSP smoke.",
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
    const violations = consoleMessages.filter((message) => cspViolation.test(message));
    if (violations.length > 0) {
      throw new Error(`Renderer emitted CSP violations:\n${violations.join("\n")}`);
    }
    if (result.inlineStyleElements !== 0) {
      throw new Error(`Renderer injected ${result.inlineStyleElements} inline style element(s)`);
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
  } finally {
    await browser.close();
  }
  console.log("Desktop renderer strict-CSP development smoke passed");
} finally {
  await stop(vite);
}
