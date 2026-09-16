/**
 * Unit tests for the `tmux-ide update` planner — the pure install-method
 * detection + plan rendering, and the git-checkout probe against a scratch dir.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  findGitCheckoutRoot,
  planUpdate,
  renderPlan,
  UPDATE_COMMANDS,
} from "../update.ts";

describe("detectPackageManager", () => {
  it("detects npm from an nvm/global node_modules path", () => {
    expect(
      detectPackageManager("/Users/x/.nvm/versions/node/v24.2.0/lib/node_modules/tmux-ide/bin"),
    ).toBe("npm");
    expect(detectPackageManager("/usr/local/lib/node_modules/tmux-ide/bin")).toBe("npm");
  });
  it("detects pnpm from a pnpm global dir", () => {
    expect(detectPackageManager("/Users/x/Library/pnpm/global/5/node_modules/tmux-ide/bin")).toBe(
      "pnpm",
    );
  });
  it("detects bun from a .bun path", () => {
    expect(detectPackageManager("/Users/x/.bun/install/global/node_modules/tmux-ide/bin")).toBe(
      "bun",
    );
    expect(detectPackageManager("/opt/bun/bin/tmux-ide")).toBe("unknown");
  });
});

describe("planUpdate", () => {
  it("plans a git pull for a checkout (gitRoot set)", () => {
    const plan = planUpdate({ cliPath: "/repo/bin", gitRoot: "/repo" });
    expect(plan.method).toBe("dev");
    expect(plan.command).toBeNull();
    expect(plan.reason).toContain("/repo");
  });
  it("plans the package-manager command for a global install", () => {
    const plan = planUpdate({
      cliPath: "/usr/local/lib/node_modules/tmux-ide/bin",
      gitRoot: null,
      currentVersion: "2.6.0",
    });
    expect(plan.method).toBe("npm");
    expect(plan.command).toBe(UPDATE_COMMANDS.npm);
  });
});

describe("renderPlan", () => {
  it("shows the git pull hint for a dev checkout", () => {
    const out = renderPlan(
      { method: "dev", command: null, reason: "git checkout at /repo" },
      { current: "2.6.0", latest: "9.9.9", dryRun: true },
    );
    expect(out).toContain("v2.6.0 → v9.9.9 available");
    expect(out).toContain("git pull");
    // Always ends with the re-adopt instruction so a fresh dock runs new code.
    expect(out).toContain("update --daemon");
  });

  it("shows the exact package-manager command and 'Would run' under --dry-run", () => {
    const out = renderPlan(
      { method: "npm", command: UPDATE_COMMANDS.npm, reason: "global npm install" },
      { current: "2.6.0", latest: "2.10.0", dryRun: true },
    );
    expect(out).toContain("Would run");
    expect(out).toContain(UPDATE_COMMANDS.npm);
  });

  it("says up to date when latest equals current", () => {
    const out = renderPlan(
      { method: "dev", command: null, reason: "git checkout at /repo" },
      { current: "2.6.0", latest: "2.6.0", dryRun: true },
    );
    expect(out).toContain("is up to date");
  });
});

describe("findGitCheckoutRoot", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tmux-ide-gitroot-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a .git at an ancestor of the start dir", () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tmux-ide" }));
    const deep = join(root, "packages", "daemon", "bin");
    mkdirSync(deep, { recursive: true });
    expect(findGitCheckoutRoot(deep)).toBe(root);
  });

  it("returns null when no .git is found up the tree", () => {
    const deep = join(root, "node_modules", "tmux-ide", "bin");
    mkdirSync(deep, { recursive: true });
    expect(findGitCheckoutRoot(deep)).toBeNull();
  });
});

describe("renderPlan version gating", () => {
  it("does not offer a downgrade when the registry lags the checkout", async () => {
    const { renderPlan } = await import("../update.ts");
    const out = renderPlan({ method: "dev", command: null, hint: "git pull" } as never, {
      current: "2.6.0",
      latest: "2.1.5",
      dryRun: true,
    });
    expect(out).toContain("up to date (registry: v2.1.5)");
    expect(out).not.toContain("available");
  });
  it("offers a real newer version", async () => {
    const { renderPlan } = await import("../update.ts");
    const out = renderPlan({ method: "dev", command: null, hint: "git pull" } as never, {
      current: "2.6.0",
      latest: "9.9.9",
      dryRun: true,
    });
    expect(out).toContain("v2.6.0 → v9.9.9 available");
  });
});

it("keeps unsupported and ambiguous layouts manual", () => {
  for (const [path, origin] of [
    ["/opt/homebrew/Cellar/tmux-ide/3.0.0/libexec/lib/node_modules/tmux-ide/bin", "homebrew"],
    ["/home/user/.npm/_npx/123/node_modules/tmux-ide/bin", "npx"],
    ["/home/user/.config/yarn/global/node_modules/tmux-ide/bin", "yarn"],
    ["/work/node_modules/tmux-ide/bin", "unknown"],
    ["/some/pnpm-project/bin", "unknown"],
  ]) {
    const plan = planUpdate({ cliPath: path!, gitRoot: null, currentVersion: "3.0.0" });
    expect(plan.method).toBe(origin);
    expect(plan.command).toBeNull();
    expect(plan.executable).toBeUndefined();
    expect(plan.guidance).toBeTruthy();
  }
  expect(
    detectPackageManager(
      "/home/user/.local/share/pnpm/global/5/.pnpm/tmux-ide@3.0.0/node_modules/tmux-ide/bin",
    ),
  ).toBe("pnpm");
  expect(
    planUpdate({
      cliPath: "/usr/lib/node_modules/tmux-ide/bin",
      gitRoot: null,
      currentVersion: "3.0.0-beta.9",
    }).args,
  ).toEqual(["install", "-g", "tmux-ide@beta"]);
});

it("resolves actual symlinked installation and emits one truthful JSON dry run without execution", async () => {
  const { runUpdate } = await import("../update.ts");
  const { symlinkSync } = await import("node:fs");
  const { vi } = await import("vitest");
  const root = mkdtempSync(join(tmpdir(), "update-plan-"));
  try {
    const bin = join(root, "lib/node_modules/tmux-ide/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "../package.json"), JSON.stringify({ name: "tmux-ide" }));
    const alias = join(root, "alias");
    symlinkSync(bin, alias);
    const output = vi.fn();
    const execute = vi.fn();
    runUpdate(
      { cliDir: alias, dryRun: true, json: true },
      {
        output,
        execute,
        query: () => join(root, "lib/node_modules"),
        currentVersion: () => "3.0.0-beta.9",
        status: () => ({ latest: "3.0.0-beta.18", updateAvailable: true }),
      },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      method: "npm",
      dryRun: true,
      executed: false,
      channel: "beta",
      args: ["install", "-g", "tmux-ide@beta"],
    });
    runUpdate(
      { cliDir: bin, dryRun: false, json: true },
      {
        output,
        execute,
        query: () => join(root, "lib/node_modules"),
        currentVersion: () => "3.0.0",
        status: () => ({ latest: null, updateAvailable: false }),
      },
    );
    expect(execute).toHaveBeenCalledWith("npm", ["install", "-g", "tmux-ide@latest"], {
      stdio: ["ignore", 2, 2],
    });
    execute.mockClear();
    const blocked = runUpdate(
      { cliDir: bin, dryRun: false, json: true },
      { output, execute, query: () => "/missing-other-prefix" },
    );
    expect(blocked.command).toBeNull();
    expect(blocked.guidance).toContain("original manager/prefix");
    expect(execute).not.toHaveBeenCalled();
    runUpdate({ cliDir: root, dryRun: false, json: true }, { execute, output });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not infer an automatic stable update from an unknown running version", () => {
  const plan = planUpdate({
    cliPath: "/usr/lib/node_modules/tmux-ide/bin",
    gitRoot: null,
    currentVersion: "unknown",
  });
  expect(plan.command).toBeNull();
  expect(plan.executable).toBeUndefined();
  expect(plan.guidance).toContain("Cannot infer a safe update channel");
});
