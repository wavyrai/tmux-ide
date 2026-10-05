import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDaemonService } from "./daemon-service-plan.ts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

const home = "/tmp/service home &'%$\\fixture";
function options(platform = "linux") {
  return {
    platform,
    uid: 501,
    home,
    executable: `${home}/.local/bin/tmux-ide`,
    path: "/usr/bin:/bin:/opt/homebrew/bin",
    namespace: resolveRuntimeNamespace({
      userHome: home,
      cwd: home,
      env: {
        TMUX_IDE_HOME: `${home}/state`,
        TMUX_IDE_DAEMON_INFO_DIR: `${home}/daemon`,
        TMUX_IDE_SETTINGS_DIR: `${home}/settings`,
        TMUX_IDE_CONFIG: `${home}/configuration.json`,
        TMUX_IDE_TMUX_SOCKET_PATH: `${home}/tmux.sock`,
      },
    }),
  };
}

describe("daemon service definition", () => {
  it("keeps the stable launcher and exact namespace across repeated planning", () => {
    const input = options();
    const plan = planDaemonService(input);
    expect(plan).toEqual(planDaemonService(input));
    expect(plan.executable).toBe(input.executable);
    expect(plan.contents).toContain('--headless" "--supervised"');
    expect(plan.contents).toContain("TMUX_IDE_SETTINGS_DIR=");
    expect(plan.contents).toContain("TMUX_IDE_TMUX_SOCKET_PATH=");
    const other = planDaemonService({
      ...input,
      namespace: { ...input.namespace, daemonInfoDir: `${home}/other-daemon` },
    });
    expect(other.supervisionId).not.toBe(plan.supervisionId);
    expect(other.unitPath).not.toBe(plan.unitPath);
  });

  it("quotes systemd values without shell, dollar or specifier expansion", () => {
    const plan = planDaemonService(options());
    expect(plan.contents).toContain("ExecStart=:\"/tmp/service home &'%%$\\\\fixture/");
    expect(plan.contents).toContain("Restart=always\n");
    expect(plan.contents).toContain("KillMode=process\n");
    expect(plan.contents).toContain("StandardOutput=journal\n");
    expect(plan.contents).not.toContain("/bin/sh");
  });

  it("rejects unsupported managers, root, relative paths and directive injection", () => {
    for (const change of [
      { platform: "win32" },
      { uid: 0 },
      { executable: "tmux-ide" },
      { configHome: "relative" },
      { executable: "/tmp/bin\nExecStart=/tmp/other" },
      { path: "/bin\nEnvironment=OTHER=value" },
    ])
      expect(() => planDaemonService({ ...options(), ...change })).toThrow();
    const input = options();
    expect(() =>
      planDaemonService({
        ...input,
        namespace: { ...input.namespace, mode: "development" },
      }),
    ).toThrow("dev:instance");
  });

  it.runIf(process.platform === "linux" && existsSync("/usr/bin/systemd-analyze"))(
    "passes the systemd parser with literal spaces and specifiers in paths",
    () => {
      const root = mkdtempSync(join(tmpdir(), "service-unit-"));
      try {
        const plan = planDaemonService({ ...options(), executable: "/usr/bin/true" });
        const path = join(root, `${plan.supervisionId}.service`);
        writeFileSync(path, plan.contents);
        expect(() => execFileSync("/usr/bin/systemd-analyze", ["verify", path])).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "round-trips launchd arguments and environment through the OS plist parser",
    () => {
      const root = mkdtempSync(join(tmpdir(), "service-plist-"));
      try {
        const input = options("darwin");
        const plan = planDaemonService(input);
        const path = join(root, "fixture.plist");
        writeFileSync(path, plan.contents);
        const parsed = JSON.parse(
          execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
            encoding: "utf8",
          }),
        );
        expect(parsed.ProgramArguments).toEqual([
          input.executable,
          "--headless",
          "--supervised",
          plan.supervisionId,
        ]);
        expect(parsed.EnvironmentVariables.HOME).toBe(home);
        expect(parsed.EnvironmentVariables.TMUX_IDE_DAEMON_INFO_DIR).toBe(`${home}/daemon`);
        expect(parsed.EnvironmentVariables.TMUX_IDE_SETTINGS_DIR).toBe(`${home}/settings`);
        expect(parsed.EnvironmentVariables.TMUX_IDE_TMUX_SOCKET_PATH).toBe(`${home}/tmux.sock`);
        expect(parsed.KeepAlive).toBe(true);
        expect(parsed.AbandonProcessGroup).toBe(true);
        expect(parsed.Label).toBe(plan.target.split("/").at(-1));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
