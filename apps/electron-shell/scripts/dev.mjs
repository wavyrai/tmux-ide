import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRenderer = process.argv.includes("--workspace");
const rendererPackage = workspaceRenderer
  ? "@tmux-ide/web-workspace"
  : "@tmux-ide/desktop-renderer";
const rendererPort = workspaceRenderer ? 4322 : 5173;
const rendererUrl = `http://127.0.0.1:${rendererPort}/`;
const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`process exited after ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function waitForRenderer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
    } catch {
      // The Vite process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("desktop renderer dev server did not start within 15 seconds");
}

function stopChildren() {
  for (const child of children) child.kill("SIGTERM");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopChildren();
    process.exitCode = 0;
  });
}

const rendererBuild = run("pnpm", ["--filter", rendererPackage, "build"], { cwd: packageRoot });
if ((await waitForExit(rendererBuild)) !== 0) process.exit(1);
const build = run(
  "node",
  ["scripts/build.mjs", ...(workspaceRenderer ? ["--renderer=workspace"] : [])],
  { cwd: packageRoot },
);
if ((await waitForExit(build)) !== 0) process.exit(1);

const vite = run(
  "pnpm",
  ["--filter", rendererPackage, "dev", "--port", String(rendererPort), "--strictPort"],
  {
    cwd: packageRoot,
  },
);
try {
  await waitForRenderer();
  const electron = run(electronPath, ["."], {
    cwd: packageRoot,
    env: { ...process.env, TMUX_IDE_RENDERER_URL: rendererUrl },
  });
  process.exitCode = await waitForExit(electron);
} finally {
  vite.kill("SIGTERM");
}
