import { describe, expect, it } from "vitest";
import { createDaemonServiceManager, type ServiceCommand } from "./daemon-service-manager.ts";
import { planDaemonService } from "./daemon-service-plan.ts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

function fixture(platform: string, replies: Awaited<ReturnType<ServiceCommand>>[] = []) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const plan = planDaemonService({
    platform,
    uid: 501,
    home: "/tmp/service-fixture",
    executable: "/tmp/service-fixture/bin/tmux-ide",
    path: "/usr/bin:/bin",
    namespace: resolveRuntimeNamespace({ userHome: "/tmp/service-fixture", env: {} }),
  });
  const run: ServiceCommand = async (file, args) => {
    calls.push({ file, args });
    return replies.shift() ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, plan, manager: createDaemonServiceManager(plan, run) };
}

describe("user service manager boundary", () => {
  it("uses only the exact launchd GUI target and graceful restart", async () => {
    const { calls, plan, manager } = fixture("darwin");
    await manager.available();
    await manager.install();
    await manager.restart();
    await manager.stop();
    expect(calls).toEqual([
      { file: "/bin/launchctl", args: ["print-disabled", "gui/501"] },
      { file: "/bin/launchctl", args: ["bootstrap", "gui/501", plan.unitPath] },
      { file: "/bin/launchctl", args: ["kill", "SIGTERM", plan.target] },
      { file: "/bin/launchctl", args: ["bootout", plan.target] },
    ]);
  });

  it("uses the systemd user manager for enable, restart, removal and reload", async () => {
    const { calls, plan, manager } = fixture("linux");
    await manager.available();
    await manager.install();
    await manager.restart();
    await manager.stop();
    await manager.reload();
    expect(calls.map(({ args }) => args)).toEqual([
      ["--user", "show-environment"],
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", plan.unitPath],
      ["--user", "restart", plan.target],
      ["--user", "disable", "--now", plan.target],
      ["--user", "daemon-reload"],
    ]);
  });

  it("recognizes launchd absence without treating permission/transport failures as absent", async () => {
    const { manager } = fixture("darwin", [
      {
        code: 113,
        stdout: "",
        stderr: 'Could not find service "fixture" in domain for user gui: 501',
      },
      { code: 113, stdout: "", stderr: "permission denied PRIVATE_TOKEN" },
      { code: null, stdout: "", stderr: "timeout PRIVATE_TOKEN" },
    ]);
    expect(await manager.inspect()).toEqual({
      loaded: false,
      active: false,
      pid: null,
      definitionPath: null,
    });
    for (let index = 0; index < 2; index++) {
      await expect(manager.inspect()).rejects.toThrow("inspection failed");
    }
  });

  it("reads only launchd top-level state and never forwards environment output", async () => {
    const { manager } = fixture("darwin", [
      {
        code: 0,
        stderr: "",
        stdout:
          "gui/501/fixture = {\n\tpath = /tmp/service fixture.plist\n\tstate = running\n\tpid = 4321\n\tenvironment = {\n\t\tPRIVATE_TOKEN => secret\n\t\tpid = 999\n\t}\n}",
      },
    ]);
    expect(await manager.inspect()).toEqual({
      loaded: true,
      active: true,
      pid: 4321,
      definitionPath: "/tmp/service fixture.plist",
    });
  });

  it("requires explicit systemd load state and complete ownership fields", async () => {
    const { manager } = fixture("linux", [
      {
        code: 4,
        stdout: "LoadState=not-found\nActiveState=inactive\nMainPID=0\nFragmentPath=\n",
        stderr: "",
      },
      {
        code: 0,
        stdout:
          "LoadState=loaded\nActiveState=active\nMainPID=4321\nFragmentPath=/tmp/fixture.service\n",
        stderr: "",
      },
      { code: 0, stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0\n", stderr: "" },
      { code: 1, stdout: "", stderr: "manager unavailable" },
    ]);
    expect((await manager.inspect()).loaded).toBe(false);
    expect(await manager.inspect()).toEqual({
      loaded: true,
      active: true,
      pid: 4321,
      definitionPath: "/tmp/fixture.service",
    });
    await expect(manager.inspect()).rejects.toThrow("inspection format");
    await expect(manager.inspect()).rejects.toThrow("inspection format");
  });

  it("stops installation when reload fails, without enabling a partially installed unit", async () => {
    const { manager, calls } = fixture("linux", [
      { code: 1, stdout: "private", stderr: "PRIVATE_TOKEN" },
    ]);
    await expect(manager.install()).rejects.toThrow("reload failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["--user", "daemon-reload"]);
  });
});
