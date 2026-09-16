import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverDevelopmentWorktree, resolveDevelopmentInstance } from "./development-instance.ts";
import {
  developmentNamespaceEnvironment,
  developmentChildEnvironment,
  resolveRuntimeNamespace,
  runtimeTmuxArgs,
} from "./runtime-namespace.ts";
import { appConfigPath, getAppConfig } from "./app-config.ts";
import { appSettingsPath } from "./app-settings.ts";
import { savedMachinesPath } from "./saved-machines.ts";
import { updateCachePath, maybeCheckForUpdate, runUpdateCheck } from "./update-check.ts";
import { claudeDir, syncSkill } from "./skill-sync.ts";
import {
  hookScriptPath,
  claudeSettingsPath,
  installClaudeIntegration,
} from "../tui/integrations/claude.ts";
import { opencodePluginPath, installOpencodeIntegration } from "../tui/integrations/opencode.ts";
import {
  compiledTuiRuntimeDir,
  findCompiledTui,
  openTuiLaunchEnvironment,
} from "../tui/compiled.ts";
import { resolveWorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { loadTerminals, upsertTerminal } from "./terminals-store.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "development-policy-"));
  roots.push(root);
  const tree = join(root, "source with spaces");
  mkdirSync(tree);
  return { root, tree, store: join(root, "store"), userHome: root };
}
function activate(instance: ReturnType<typeof resolveDevelopmentInstance>) {
  const env = developmentNamespaceEnvironment(instance, "development:fixture:capability");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("TMUX", "");
  vi.stubEnv("TMUX_PANE", "");
  return env;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("canonicalizes aliases and keeps branch metadata out of stable worktree/name identity", () => {
  const f = fixture();
  execFileSync("git", ["init", "-q", f.tree]);
  const alias = join(f.root, "alias");
  symlinkSync(f.tree, alias);
  const first = resolveDevelopmentInstance({ ...f, worktree: discoverDevelopmentWorktree(alias) });
  const second = resolveDevelopmentInstance({ ...f, worktree: alias });
  expect(second).toEqual(first);
  execFileSync("git", ["-C", f.tree, "symbolic-ref", "HEAD", "refs/heads/different"]);
  expect(resolveDevelopmentInstance({ ...f, worktree: f.tree }).id).toBe(first.id);
  expect(resolveDevelopmentInstance({ ...f, worktree: f.tree, name: "another" }).id).not.toBe(
    first.id,
  );
  expect(() => resolveDevelopmentInstance({ ...f, worktree: f.tree, name: " another " })).toThrow(
    "name",
  );
});

it("derives disjoint durable bundles for long trees without lengthening private sockets", () => {
  const f = fixture();
  const secondTree = join(f.root, "long".repeat(50));
  mkdirSync(secondTree);
  const a = resolveDevelopmentInstance({ ...f, worktree: f.tree });
  const b = resolveDevelopmentInstance({ ...f, worktree: secondTree });
  const an = resolveRuntimeNamespace({
    env: developmentNamespaceEnvironment(a, "fixture:capability:one"),
  });
  const bn = resolveRuntimeNamespace({
    env: developmentNamespaceEnvironment(b, "fixture:capability:two"),
  });
  expect(an.persistence).toBe("durable");
  expect(an.isolated).toBe(true);
  expect(an.namespaceId).toBe(a.id);
  expect(an.namespaceId).not.toBe(an.cleanupToken);
  for (const key of [
    "stateHome",
    "runtimeDir",
    "controlSocketPath",
    "configPath",
    "settingsDir",
    "claudeHookPath",
    "opencodeDir",
  ] as const)
    expect(an[key]).not.toBe(bn[key]);
  expect(Buffer.byteLength(an.controlSocketPath)).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(bn.controlSocketPath)).toBeLessThanOrEqual(100);
});

it("rejects incomplete identity, conflicting socket, inherited authority and escaping overrides", () => {
  const f = fixture();
  const instance = resolveDevelopmentInstance({ ...f, worktree: f.tree });
  const env = developmentNamespaceEnvironment(instance, "fixture:capability:one");
  for (const key of [
    "TMUX_IDE_DEVELOPMENT_ID",
    "TMUX_IDE_DEVELOPMENT_WORKTREE",
    "TMUX_IDE_REGISTRY_DIR",
    "TMUX_IDE_RUNTIME_DIR",
    "TMUX_IDE_CLEANUP_TOKEN",
  ]) {
    const broken = { ...env };
    delete broken[key];
    expect(() => resolveRuntimeNamespace({ env: broken })).toThrow();
  }
  for (const extra of [
    { TMUX_IDE_TMUX_SOCKET_NAME: "default" },
    { TMUX: "/tmp/other,123,0" },
    { TMUX_IDE_CONFIG: join(f.root, "outside.json") },
    { TMUX_IDE_CLAUDE_DIR: join(f.root, "personal") },
    { TMUX_IDE_REGISTRY_DIR: join(f.root, "other") },
    { TMUX_IDE_TUI_LOG: "/tmp/escape.log" },
    { TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1" },
    { TMUX_IDE_RUNTIME_MODE: "typo" },
  ])
    expect(() => resolveRuntimeNamespace({ env: { ...env, ...extra } })).toThrow();
  const namespace = resolveRuntimeNamespace({ env });
  const clean = developmentChildEnvironment(namespace, {
    HOME: f.root,
    PATH: "/bin",
    TMUX: "/other,1,0",
    TMUX_PANE: "%2",
    TMUX_IDE_TUI_BIN: "/installed",
    TMUX_IDE_TMUX_SOCKET_NAME: "default",
  });
  expect(clean.HOME).toBe(f.root);
  expect(clean.TMUX).toBeUndefined();
  expect(clean.TMUX_PANE).toBeUndefined();
  expect(clean.TMUX_IDE_TUI_BIN).toBeUndefined();
  expect(resolveRuntimeNamespace({ env: clean }).namespaceId).toBe(instance.id);
});

it("rejects canonical/sibling stores and symlink or non-private owned state before creation", () => {
  const f = fixture();
  expect(() =>
    resolveDevelopmentInstance({ ...f, worktree: f.tree, store: join(f.root, ".tmux-ide", "dev") }),
  ).toThrow("canonical");
  expect(() =>
    resolveDevelopmentInstance({
      ...f,
      worktree: f.tree,
      store: join(f.store, "instances", `dev-${"a".repeat(24)}`, "nested"),
    }),
  ).toThrow("sibling");
  const instance = resolveDevelopmentInstance({ ...f, worktree: f.tree });
  mkdirSync(instance.root, { recursive: true, mode: 0o700 });
  symlinkSync(f.tree, instance.stateHome);
  expect(() => resolveDevelopmentInstance({ ...f, worktree: f.tree })).toThrow("Unsafe");
  unlinkSync(instance.stateHome);
  chmodSync(instance.root, 0o755);
  expect(() => resolveDevelopmentInstance({ ...f, worktree: f.tree })).toThrow("private");
});

it("routes all common consumers and project terminal receipts through the selected bundle", () => {
  const f = fixture();
  const instance = resolveDevelopmentInstance({ ...f, worktree: f.tree });
  activate(instance);
  const ns = resolveRuntimeNamespace();
  for (const path of [
    appConfigPath(),
    appSettingsPath(),
    savedMachinesPath(),
    updateCachePath(),
    claudeDir(),
    hookScriptPath(),
    claudeSettingsPath(),
    opencodePluginPath(),
  ])
    expect(path.startsWith(`${instance.root}/`)).toBe(true);
  expect(compiledTuiRuntimeDir()).toBe(join(instance.runtimeDir, "compiled-tui"));
  mkdirSync(instance.stateHome, { recursive: true, mode: 0o700 });
  writeFileSync(appConfigPath(), JSON.stringify({ updates: { check: false } }));
  expect(getAppConfig().updates.check).toBe(false);
  upsertTerminal(f.tree, {
    id: "one",
    projectId: "project",
    scopeId: "scope",
    name: "terminal",
    kind: "shell",
  });
  expect(loadTerminals(f.tree)).toHaveLength(1);
  expect(existsSync(join(f.tree, ".tmux-ide", "terminals.json"))).toBe(false);
  const other = resolveDevelopmentInstance({ ...f, worktree: f.tree, name: "other" });
  activate(other);
  expect(loadTerminals(f.tree)).toEqual([]);
  expect(getAppConfig().updates.check).toBe(true);
  expect(ns.namespaceId).not.toBe(resolveRuntimeNamespace().namespaceId);
});

it("suppresses global side effects and rejects unqualified artifact fallback", async () => {
  const f = fixture();
  activate(resolveDevelopmentInstance({ ...f, worktree: f.tree }));
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(maybeCheckForUpdate({ enabled: true }).updateAvailable).toBe(false);
  await runUpdateCheck();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
  expect(() => syncSkill()).toThrow("disabled");
  expect(() => installClaudeIntegration()).toThrow("fixture paths");
  expect(() => installOpencodeIntegration()).toThrow("disabled");
  expect(() => findCompiledTui()).toThrow("manifest");
  const namespace = resolveRuntimeNamespace();
  expect(runtimeTmuxArgs(["capture-pane", "-S", "-1"])).toEqual([
    "-S",
    join(namespace.runtimeDir, "tmux.sock"),
    "capture-pane",
    "-S",
    "-1",
  ]);
  expect(resolveWorkspacePaneTmuxAuthority().socketSelector).toEqual(namespace.tmuxSocket);
});

it("rejects existing config/catalog/integration symlinks and namespace-changing child overlays", () => {
  const f = fixture();
  const instance = resolveDevelopmentInstance({ ...f, worktree: f.tree });
  const env = activate(instance);
  mkdirSync(instance.stateHome, { recursive: true, mode: 0o700 });
  const outside = join(f.root, "outside.json");
  writeFileSync(outside, "{}");
  const config = join(instance.stateHome, "config.json");
  symlinkSync(outside, config);
  expect(() => appConfigPath()).toThrow("escapes");
  unlinkSync(config);
  symlinkSync(join(f.root, "missing", "outside.json"), config);
  expect(() => appConfigPath()).toThrow();
  unlinkSync(config);
  const machines = join(instance.stateHome, "machines.json");
  symlinkSync(outside, machines);
  expect(() => savedMachinesPath()).toThrow("escapes");
  unlinkSync(machines);
  const integrations = join(instance.stateHome, "integrations");
  symlinkSync(f.tree, integrations);
  expect(() => claudeSettingsPath()).toThrow("escapes");
  unlinkSync(integrations);
  expect(() => openTuiLaunchEnvironment(env, { TMUX_IDE_RUNTIME_MODE: "production" })).toThrow(
    "changed namespace",
  );
  expect(() => runtimeTmuxArgs(["-S"])).toThrow("Conflicting");
  expect(() => runtimeTmuxArgs(["-f", "/config", "-L", "default", "list-sessions"])).toThrow(
    "Conflicting",
  );
});

it("retains production empty/relative config override compatibility", () => {
  expect(resolveRuntimeNamespace({ env: { TMUX_IDE_CONFIG: "" } }).configPath).toBe("");
  expect(
    resolveRuntimeNamespace({
      env: { TMUX_IDE_CONFIG: "relative.json", TMUX_IDE_SETTINGS_DIR: "" },
    }).configPath,
  ).toBe("relative.json");
});
