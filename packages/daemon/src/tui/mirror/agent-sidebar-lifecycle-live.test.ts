import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createStatusTracker } from "../detect/classify.ts";
import { listTeamSessions } from "../team/sessions.ts";
import { agentDisplayKind, agentRowLabel } from "./agent-rows.ts";
import { diffChangedSessions } from "../../command-center/agent-status-watch.ts";
import { readAgentStateFacts } from "../../command-center/daemon-fleet-facts-observer.ts";
import { MirrorControlChannel } from "../../terminal/mirror/control-channel.ts";
import { MirrorService } from "../../terminal/mirror/mirror-service.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const hasCc = spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Real sidebar lifecycle proof: no @agent_hint or @agent_display_name stamps are used.
 * A copied stdin/stdout process named `codex` is a deterministic, input-capable
 * representative process, so both pane_current_command and the process-tree
 * fallback discover it exactly as a normal installed agent executable.
 */
describe.skipIf(!hasTmux || !hasCc).sequential("real agent sidebar lifecycle", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-agent-sidebar-live-"));
  const socketPath = join(root, "tmux.sock");
  const session = `agent-sidebar-${randomUUID().slice(0, 8)}`;
  const tmuxBin = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const agentBinDir = join(root, "bin");
  const agentBin = join(agentBinDir, "codex");
  const agentSource = join(agentBinDir, "codex.c");
  const previousTmux = process.env.TMUX;
  let service: MirrorService | null = null;

  const run = (argv: readonly string[]): string =>
    execFileSync(tmuxBin, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMUX: "" },
    }).replace(/(?:\r?\n)+$/u, "");

  const spawnAgentWindow = (): string =>
    run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      `${session}:`,
      "-n",
      "agent",
      "-c",
      root,
      `exec ${agentBin}`,
    ]);

  const spawnShellWindow = (): string =>
    run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      `${session}:`,
      "-n",
      "agent-race",
      "-c",
      root,
      "exec sh -i",
    ]);

  const agents = () =>
    listTeamSessions(createStatusTracker())
      .find((candidate) => candidate.name === session)
      ?.agents?.filter((agent) => agent.kind === "codex") ?? [];

  beforeAll(() => {
    mkdirSync(agentBinDir);
    writeFileSync(
      agentSource,
      "#include <unistd.h>\nint main(void){char b[1024];for(;;){ssize_t n=read(0,b,sizeof b);if(n>0)(void)write(1,b,(size_t)n);else usleep(10000);}}\n",
    );
    execFileSync("cc", [agentSource, "-o", agentBin], { stdio: "ignore" });
    chmodSync(agentBin, 0o700);
    run(["-f", "/dev/null", "new-session", "-d", "-s", session, "exec sh -i"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;
  });

  afterAll(async () => {
    await service?.dispose();
    service = null;
    spawnSync(tmuxBin, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers, names, focuses, removes, and recreates one exact agent without duplicates", async () => {
    const firstPane = spawnAgentWindow();
    expect(firstPane).toMatch(/^%\d+$/u);

    await vi.waitFor(
      () => {
        expect(agents()).toHaveLength(1);
        expect(agents()[0]).toMatchObject({ paneId: firstPane, kind: "codex", command: "codex" });
      },
      { timeout: 10_000, interval: 50 },
    );

    run(["select-window", "-t", firstPane]);
    run(["select-pane", "-t", firstPane]);

    service = new MirrorService({
      createIo: (target, handlers) =>
        new MirrorControlChannel({
          session: target,
          handlers,
          socketPath,
          configFile: "/dev/null",
        }),
    });
    const firstDescription = await service.describeSession(session);
    const firstSemantic = firstDescription.panes.find((pane) => pane.currentCommand === "codex");
    expect(firstSemantic, JSON.stringify(firstDescription.panes)).toMatchObject({
      displayName: "codex",
      displayNameSource: "process",
      currentCommand: "codex",
    });
    expect(firstSemantic?.semanticPaneId).toMatch(/^pane\./u);
    expect(agentDisplayKind(agents()[0]!)).toBe("codex");
    expect(agentRowLabel(agentDisplayKind(agents()[0]!), session, 120)).toBe(`codex · ${session}`);

    const firstMarker = `FIRST_AGENT_INPUT_${randomUUID().slice(0, 8)}`;
    run(["send-keys", "-l", "-t", firstPane, firstMarker]);
    run(["send-keys", "-t", firstPane, "Enter"]);
    await vi.waitFor(
      () => expect(run(["capture-pane", "-p", "-t", firstPane])).toContain(firstMarker),
      {
        timeout: 10_000,
        interval: 50,
      },
    );

    run(["kill-pane", "-t", firstPane]);
    await vi.waitFor(() => expect(agents()).toEqual([]), { timeout: 10_000, interval: 50 });

    // Reproduce the installed lifecycle race: tmux publishes the new pane while
    // its shell is still foreground, then the child execs into an agent. The
    // daemon's agent facts must invalidate on that command transition even
    // though neither @agent_state nor the pane id changed.
    const secondPane = spawnShellWindow();
    expect(secondPane).toMatch(/^%\d+$/u);
    expect(secondPane).not.toBe(firstPane);
    const beforeExec = await readAgentStateFacts();
    expect(beforeExec?.get(session)?.get(secondPane)?.command).toMatch(/^(?:ba|z)?sh$/u);
    run(["send-keys", "-l", "-t", secondPane, `exec ${agentBin}`]);
    run(["send-keys", "-t", secondPane, "Enter"]);
    await vi.waitFor(
      () =>
        expect(run(["display-message", "-p", "-t", secondPane, "#{pane_current_command}"])).toBe(
          "codex",
        ),
      { timeout: 10_000, interval: 50 },
    );
    const afterExec = await readAgentStateFacts();
    expect(diffChangedSessions(beforeExec!, afterExec!)).toEqual([session]);
    await vi.waitFor(
      () => {
        const rows = agents();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ paneId: secondPane, kind: "codex", command: "codex" });
        expect(new Set(rows.map((row) => row.paneId))).toEqual(new Set([secondPane]));
      },
      { timeout: 10_000, interval: 50 },
    );

    await vi.waitFor(
      async () => {
        const description = await service!.describeSession(session);
        const recreated = description.panes.filter((pane) => pane.currentCommand === "codex");
        expect(recreated).toHaveLength(1);
        expect(recreated[0]).toMatchObject({ displayName: "codex", displayNameSource: "process" });
        expect(recreated[0]!.semanticPaneId).not.toBe(firstSemantic!.semanticPaneId);
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});
