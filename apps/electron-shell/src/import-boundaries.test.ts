import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DAEMON_RESOURCE_KINDS } from "@tmux-ide/contracts";

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
      HOST_IPC.windowMinimize,
      HOST_IPC.windowToggleMaximized,
      HOST_IPC.windowClose,
      HOST_IPC.workspaceOpenProjectDirectory,
      HOST_IPC.onboardingAcknowledgeIntro,
      HOST_IPC.updateGetStatus,
      HOST_IPC.daemonRequest,
      HOST_IPC.daemonSubscribe,
      HOST_IPC.daemonUnsubscribe,
    ]);
    expect(Object.values(HOST_IPC)).not.toContain("tmux-ide:host/send");
    expect(Object.values(HOST_IPC)).not.toContain("tmux-ide:host/eval");
    expect(Object.values(HOST_IPC)).not.toContain("tmux-ide:host/command");
    expect(
      Object.values(HOST_IPC).some((channel) => /byte|pty|terminal-data/iu.test(channel)),
    ).toBe(false);
  });

  it("reaches every daemon resource over exactly one request channel", () => {
    // The channel is one; the reachable surface is still the closed union, so
    // "generic channel" and "generic capability" stay different things.
    const daemonChannels = HOST_INVOKE_CHANNELS.filter((channel) => channel.includes("/daemon/"));
    expect(daemonChannels).toEqual([
      HOST_IPC.daemonRequest,
      HOST_IPC.daemonSubscribe,
      HOST_IPC.daemonUnsubscribe,
    ]);
    // Sixteen since m49.1 added `invokeVerb`. That resource carries all seven
    // multiplexer verbs, so the count grew by one rather than by seven — which
    // is the property this assertion is really guarding.
    expect(DAEMON_RESOURCE_KINDS.length).toBe(16);
    expect(new Set(DAEMON_RESOURCE_KINDS).size).toBe(DAEMON_RESOURCE_KINDS.length);
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
    expect(preload).not.toContain("apiBaseUrl");
    expect(preload).not.toMatch(/\bfetch\s*\(|new\s+WebSocket\b/u);
  });

  it("ships a strict browser renderer policy", async () => {
    const html = await readFile(join(packageRoot, "..", "desktop-renderer", "index.html"), "utf8");
    expect(html).not.toMatch(/Content-Security-Policy/iu);

    const vite = await readFile(
      join(packageRoot, "..", "desktop-renderer", "vite.config.ts"),
      "utf8",
    );
    expect(vite).toContain('"Content-Security-Policy"');
    expect(vite).toContain("default-src 'self'");
    expect(vite).toContain("object-src 'none'");
    expect(vite).toContain("frame-ancestors 'none'");
    expect(vite).toContain("ws://127.0.0.1:${devServerPort}");
    expect(vite).toContain('VITE_TMUX_IDE_DEV_GATEWAY === "1"');
    expect(vite).toContain("TMUX_IDE_DEV_OWNER_TOKEN");
    expect(vite).not.toContain("VITE_TMUX_IDE_DEV_OWNER_TOKEN");
    expect(vite).toContain("sourcemap: false");
    expect(vite).toContain("\"script-src 'self'\"");
    expect(vite).toContain("\"style-src-elem 'self' 'unsafe-inline'\"");
    expect(vite).toContain("\"style-src-attr 'unsafe-inline'\"");
    expect(vite).not.toContain("unsafe-eval");
  });
});
