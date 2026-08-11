/**
 * Resolution-order tests for the TUI launch decision — the pure heart of
 * single-binary distribution (checkout `.tsx` via bun in dev, compiled
 * `tmux-ide-tui` binary when installed).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compiledTuiRuntimeDir,
  ensureCompiledTuiRuntimeDir,
  resolveTuiLaunch,
} from "./compiled.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

const base = {
  surface: "explorer",
  scriptPath: "/checkout/widgets/explorer/index.tsx",
  args: ["--session=s", "--dir=/proj"],
};

describe("resolveTuiLaunch — fast binary with an explicit source override", () => {
  it("uses the compiled binary when both paths are present", () => {
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: true,
      bunAvailable: true,
      compiledBinary: "/usr/local/bin/tmux-ide-tui",
    });
    expect(launch.mode).toBe("binary");
    if (launch.mode !== "binary") throw new Error("unreachable");
    expect(launch.bin).toBe("/usr/local/bin/tmux-ide-tui");
    expect(launch.argv).toEqual([base.surface, ...base.args]);
  });

  it("uses live checkout sources only when development mode asks for them", () => {
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: true,
      bunAvailable: true,
      compiledBinary: "/some/tmux-ide-tui",
      preferSource: true,
    });
    expect(launch.mode).toBe("bun");
    if (launch.mode !== "bun") throw new Error("unreachable");
    expect(launch.argv).toEqual([base.scriptPath, ...base.args]);
  });

  it("falls back to the binary when the checkout sources are absent (installed)", () => {
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: false,
      bunAvailable: false,
      compiledBinary: "/usr/local/bin/tmux-ide-tui",
    });
    expect(launch.mode).toBe("binary");
    if (launch.mode !== "binary") throw new Error("unreachable");
    expect(launch.bin).toBe("/usr/local/bin/tmux-ide-tui");
    // The binary is a dispatcher: first argv is the surface token.
    expect(launch.argv).toEqual([base.surface, ...base.args]);
  });

  it("falls back to the binary when the checkout exists but bun is missing", () => {
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: true,
      bunAvailable: false,
      compiledBinary: "/opt/tmux-ide-tui",
    });
    expect(launch.mode).toBe("binary");
  });

  it("is unavailable with actionable reasons when neither path is present", () => {
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: false,
      bunAvailable: false,
      compiledBinary: null,
    });
    expect(launch.mode).toBe("unavailable");
    if (launch.mode !== "unavailable") throw new Error("unreachable");
    expect(launch.reasons.join(" ")).toMatch(/tmux-ide-tui/);
    expect(launch.reasons.join(" ")).toMatch(/sources are absent/);
    expect(launch.reasons.join(" ")).toMatch(/bun/);
  });

  it("launches via bun (not unavailable) when checkout + bun exist but no binary", () => {
    // The binary is only a fallback; with checkout + bun present its absence
    // is irrelevant.
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: true,
      bunAvailable: true,
      compiledBinary: null,
    });
    expect(launch.mode).toBe("bun");
  });

  it("omits the missing-sources reason when only bun + binary are absent", () => {
    const launch = resolveTuiLaunch({
      ...base,
      checkoutExists: true,
      bunAvailable: false,
      compiledBinary: null,
    });
    expect(launch.mode).toBe("unavailable");
    if (launch.mode !== "unavailable") throw new Error("unreachable");
    // Sources are present, so that reason must not appear; bun + binary do.
    expect(launch.reasons.join(" ")).not.toMatch(/sources are absent/);
    expect(launch.reasons.join(" ")).toMatch(/bun/);
    expect(launch.reasons.join(" ")).toMatch(/no compiled `tmux-ide-tui`/);
  });
});

describe("build-tui script — CI-safe smoke (contract, not a real compile)", () => {
  const script = resolve(repoRoot, "scripts/build-tui.mjs");

  it("exists", () => {
    expect(existsSync(script)).toBe(true);
  });

  it("compiles the dispatcher entry with the OpenTUI solid plugin", () => {
    const src = readFileSync(script, "utf-8");
    expect(src).toMatch(/tui\/main\.ts/);
    expect(src).toMatch(/@opentui\/solid\/bun-plugin/);
    expect(src).toMatch(/compile:/);
    expect(src).toMatch(/tmux-ide-tui/);
  });

  it("targets the daemon dist path the CLI probes for", () => {
    const src = readFileSync(script, "utf-8");
    expect(src).toMatch(/packages\/daemon\/dist\/tui/);
  });
});

describe("packed-install OpenTUI gate", () => {
  const script = resolve(repoRoot, "scripts/pack-check-run.mjs");

  it("launches the installed CLI against an ordinary configless tmux session", () => {
    const src = readFileSync(script, "utf-8");
    expect(src).toMatch(/tmux-ide-tui-\$\{platformTag\}-\$\{packageVersion\}/);
    expect(src).toMatch(/installedCli\)} app/);
    expect(src).toMatch(/ordinary-isolated/);
    expect(src).toMatch(/preload not found/);
    expect(src).toMatch(/NODE_PATH: ""/);
  });

  it("cannot leak a host-only compiled binary into the universal tarball", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
      files: string[];
    };
    expect(pkg.files).not.toContain("packages/daemon/dist");
    expect(pkg.files).toContain("packages/daemon/dist/**/*.js");
    expect(pkg.files).toContain("packages/daemon/dist/native/**");
  });
});

describe("compiled TUI runtime cwd", () => {
  it("uses a dedicated directory outside the project cwd", () => {
    expect(compiledTuiRuntimeDir("/Users/example")).toBe(
      "/Users/example/.tmux-ide/runtime/compiled-tui",
    );
  });

  it("creates the isolated directory recursively", () => {
    const home = resolve(tmpdir(), `tmux-ide-compiled-test-${process.pid}-${Date.now()}`);
    try {
      const dir = ensureCompiledTuiRuntimeDir(home);
      expect(dir).toBe(resolve(home, ".tmux-ide/runtime/compiled-tui"));
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
