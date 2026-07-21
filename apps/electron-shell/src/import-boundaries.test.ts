import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HOST_INVOKE_CHANNELS, HOST_IPC } from "./ipc-channels.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBuiltins = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/u, "")));

function importedSpecifiers(source: string): string[] {
  const matches = source.matchAll(
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/gu,
  );
  return [...matches].map((match) => match[1]).filter((value): value is string => !!value);
}

function isNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/u, "");
  return nodeBuiltins.has(normalized) || nodeBuiltins.has(normalized.split("/")[0] ?? "");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => [".ts", ".tsx"].includes(extname(path)));
}

describe("desktop process boundaries", () => {
  it("keeps Electron and Node imports out of the browser renderer", async () => {
    const rendererSource = join(packageRoot, "..", "desktop-renderer", "src");
    for (const path of await sourceFiles(rendererSource)) {
      const source = await readFile(path, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        expect(isNodeBuiltin(specifier), `${path} imports Node built-in ${specifier}`).toBe(false);
        expect(specifier, path).not.toMatch(/^electron(?:\/|$)/u);
        expect(specifier, path).not.toMatch(/^@tmux-ide\/electron-shell(?:\/|$)/u);
      }
    }
  });

  it("exposes only the reviewed invoke vocabulary", () => {
    expect(HOST_INVOKE_CHANNELS).toEqual([
      HOST_IPC.bootstrap,
      HOST_IPC.lifecycleQuit,
      HOST_IPC.windowGetState,
      HOST_IPC.windowMinimize,
      HOST_IPC.windowToggleMaximized,
      HOST_IPC.windowClose,
      HOST_IPC.menuShowApplication,
      HOST_IPC.dialogSelectProjectDirectory,
      HOST_IPC.themeGetState,
    ]);
    expect(Object.values(HOST_IPC)).not.toContain("tmux-ide:host/send");
    expect(Object.values(HOST_IPC)).not.toContain("tmux-ide:host/eval");
    expect(Object.values(HOST_IPC)).not.toContain("tmux-ide:host/command");
  });

  it("keeps canonical daemon attachment in Electron main and out of preload", async () => {
    const preflight = await readFile(join(packageRoot, "src", "daemon-preflight.ts"), "utf8");
    const preload = await readFile(join(packageRoot, "src", "preload.ts"), "utf8");

    expect(importedSpecifiers(preflight)).toContain("../../../packages/daemon/src/canonical.ts");
    expect(importedSpecifiers(preflight)).not.toContain("@tmux-ide/daemon");
    expect(importedSpecifiers(preload).some((specifier) => specifier.includes("daemon/src"))).toBe(
      false,
    );
    expect(importedSpecifiers(preload).some(isNodeBuiltin)).toBe(false);
  });

  it("ships a strict browser renderer policy", async () => {
    const html = await readFile(join(packageRoot, "..", "desktop-renderer", "index.html"), "utf8");
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/unsafe-(?:inline|eval)/u);
  });
});
