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
  ensureTuiLaunchAvailable,
  ensureCompiledTuiRuntimeDir,
  openTuiLaunchEnvironment,
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

describe("openTuiLaunchEnvironment", () => {
  it("advertises truecolor and removes inherited color suppression", () => {
    const inherited = {
      TERM: "xterm-256color",
      COLORTERM: "",
      NO_COLOR: "1",
      PATH: "/usr/bin",
    };

    const environment = openTuiLaunchEnvironment(inherited, {
      TMUX_IDE_CWD: "/work",
      COLORTERM: "ansi",
      NO_COLOR: "still-no",
    });

    expect(environment).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: "/usr/bin",
      TMUX_IDE_CWD: "/work",
    });
    expect(environment).not.toHaveProperty("NO_COLOR");
    expect(inherited).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "",
      NO_COLOR: "1",
      PATH: "/usr/bin",
    });
  });
});

describe("ensureTuiLaunchAvailable — installed first run", () => {
  it("does not acquire when an exact-version binary is already present", async () => {
    let downloads = 0;
    const launch = await ensureTuiLaunchAvailable(
      {
        ...base,
        checkoutExists: false,
        bunAvailable: false,
        compiledBinary: "/installed/tmux-ide-tui",
      },
      {
        download: async () => {
          downloads += 1;
          return { path: "/downloaded/tmux-ide-tui", bytes: 20_000_000 };
        },
      },
    );

    expect(downloads).toBe(0);
    expect(launch).toEqual({
      mode: "binary",
      bin: "/installed/tmux-ide-tui",
      argv: [base.surface, ...base.args],
    });
  });

  it("keeps a Bun-backed development checkout entirely local", async () => {
    let downloads = 0;
    const launch = await ensureTuiLaunchAvailable(
      {
        ...base,
        checkoutExists: true,
        bunAvailable: true,
        compiledBinary: null,
      },
      {
        download: async () => {
          downloads += 1;
          return { path: "/downloaded/tmux-ide-tui", bytes: 20_000_000 };
        },
      },
    );

    expect(downloads).toBe(0);
    expect(launch.mode).toBe("bun");
  });

  it("acquires the release runtime when a clean install has no Bun or binary", async () => {
    const messages: string[] = [];
    const launch = await ensureTuiLaunchAvailable(
      {
        ...base,
        checkoutExists: true,
        bunAvailable: false,
        compiledBinary: null,
      },
      {
        log: (message) => messages.push(message),
        download: async ({ log }) => {
          log?.("downloading exact runtime");
          return { path: "/downloaded/tmux-ide-tui", bytes: 20_000_000 };
        },
      },
    );

    expect(messages).toEqual(["downloading exact runtime"]);
    expect(launch).toEqual({
      mode: "binary",
      bin: "/downloaded/tmux-ide-tui",
      argv: [base.surface, ...base.args],
    });
  });

  it("names the failed boundary and the explicit retry command", async () => {
    await expect(
      ensureTuiLaunchAvailable(
        {
          ...base,
          checkoutExists: true,
          bunAvailable: false,
          compiledBinary: null,
        },
        {
          download: async () => {
            throw new Error("release asset returned HTTP 404");
          },
        },
      ),
    ).rejects.toThrow(
      /Automatic OpenTUI runtime acquisition failed: release asset returned HTTP 404[\s\S]*tmux-ide update --tui-binary/u,
    );
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
  const cli = readFileSync(resolve(repoRoot, "bin/cli.ts"), "utf8");

  it("prepares the renderer before creating a persistent daemon", () => {
    const runApp = cli.slice(
      cli.indexOf("async function runApp"),
      cli.indexOf("function launchApp"),
    );
    expect(runApp.indexOf("ensureTuiLaunchAvailable")).toBeGreaterThanOrEqual(0);
    expect(runApp.indexOf("ensureCanonicalDaemon")).toBeGreaterThan(
      runApp.indexOf("ensureTuiLaunchAvailable"),
    );
  });

  it("keeps the deferred Web GUI out of the OpenTUI beta command graph", () => {
    expect(cli).toContain("The Web GUI is not included in the OpenTUI beta");
    expect(cli).not.toContain("production-web-server.ts");
    expect(cli).not.toMatch(/tmux-ide web.*Serve the packaged Web GUI/u);
  });

  it("launches the installed CLI against an ordinary configless tmux session", () => {
    const src = readFileSync(script, "utf-8");
    expect(src).toMatch(/tmux-ide-tui-\$\{platformTag\}-\$\{packageVersion\}/);
    expect(src).toMatch(/installedCli\)} app/);
    expect(src).toMatch(/ordinary-isolated/);
    expect(src).toMatch(/first-terminal-frame/);
    expect(src).toMatch(/M59_PACKED_INPUT_/);
    expect(src).toMatch(/@tmux_ide_adopted/);
    expect(src).toMatch(/@tmux_ide_workspace_promoted_v1/);
    expect(src).toMatch(/exited \$\{earlyStatus\} before terminal readiness/);
    expect(src).toMatch(/\.\.\.tmuxEnv\(dirname\(installedCli\)\)/);
    expect(src).toContain('TMUX: ""');
    expect(src).toContain("TMUX_IDE_TMUX_SOCKET_PATH: installedTmuxSocketPath");
    expect(src).toContain('["-S", installedTmuxSocketPath, "kill-server"]');
    expect(src).toContain('["show-options", "-v", "-t", targetSession, option]');
    expect(src).toContain('process.kill(pid, "SIGTERM")');
    expect(src).toContain('process.kill(pid, "SIGKILL")');
    expect(src).toContain('["-p", String(pid), "-o", "lstart=", "-o", "command="]');
    expect(src).toContain("processIdentity(pid) !== identity");
    expect(src).toMatch(/preload not found/);
    expect(src).toMatch(/NODE_PATH: ""/);
    expect(src).toMatch(/Automatic OpenTUI runtime acquisition failed/);
    expect(src).toMatch(/TMUX_IDE_PACK_FETCH_MODE/);
    expect(src).toMatch(/mock release channel/);
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
