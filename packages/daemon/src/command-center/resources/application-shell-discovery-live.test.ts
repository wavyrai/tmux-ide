import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setTmuxRunner, discoverApplicationShellSession } from "../discovery.ts";
import { projectApplicationShellResource } from "./application-shell.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `tmux-ide-inventory-${process.pid}-${randomUUID().slice(0, 8)}`;
const sessionName = "inventory-live";
const sleepCommand = "exec sleep 2147483647";

function runTmux(args: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe.skipIf(!hasTmux)("application-shell real all-window discovery", () => {
  let restoreRunner: (() => void) | null = null;
  let runtimePaneIds: string[] = [];
  const adversarialName = 'Agent "quoted" \\ path\tline\nnext\x01end';
  const adversarialStamp = 'bad "stamp" \\ path\tline\nnext';

  beforeAll(() => {
    runTmux(["new-session", "-d", "-s", sessionName, "-n", "agent", sleepCommand]);
    runTmux(["new-window", "-d", "-t", `=${sessionName}:`, "-n", "legacy", sleepCommand]);
    runTmux(["new-window", "-d", "-t", `=${sessionName}:`, "-n", "split", sleepCommand]);
    runTmux(["split-window", "-d", "-t", `=${sessionName}:split`, sleepCommand]);
    runTmux(["set-option", "-w", "-t", `=${sessionName}:agent`, "allow-rename", "off"]);
    runTmux(["set-option", "-w", "-t", `=${sessionName}:legacy`, "allow-rename", "off"]);
    runTmux(["set-option", "-w", "-t", `=${sessionName}:split`, "allow-rename", "off"]);

    const agentPane = runTmux([
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:agent`,
      "#{pane_id}",
    ]);
    const legacyPane = runTmux([
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:legacy`,
      "#{pane_id}",
    ]);
    const splitPanes = runTmux([
      "list-panes",
      "-t",
      `=${sessionName}:split`,
      "-F",
      "#{pane_id}",
    ]).split("\n");
    runtimePaneIds = [agentPane, legacyPane, ...splitPanes];

    runTmux(["set-option", "-p", "-t", agentPane, "@tmux_ide_pane_id", "pane.live-agent"]);
    runTmux(["set-option", "-p", "-t", agentPane, "@ide_type", "agent"]);
    runTmux(["set-option", "-p", "-t", agentPane, "@ide_name", adversarialName]);
    runTmux(["set-option", "-p", "-t", legacyPane, "@tmux_ide_pane_id", adversarialStamp]);
    splitPanes.forEach((paneId, index) =>
      runTmux([
        "set-option",
        "-p",
        "-t",
        paneId,
        "@tmux_ide_pane_id",
        `pane.live-split-${index + 1}`,
      ]),
    );
    runTmux(["select-window", "-t", `=${sessionName}:legacy`]);

    restoreRunner = _setTmuxRunner((args) => runTmux(args));
  });

  afterAll(() => {
    restoreRunner?.();
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  });

  it("atomically decodes qa metadata and enumerates every pane in every window", () => {
    const first = discoverApplicationShellSession(sessionName)!;
    const second = discoverApplicationShellSession(sessionName)!;
    expect(first.panes).toHaveLength(4);
    expect(new Set(first.panes.map(({ windowId }) => windowId)).size).toBe(3);
    expect(
      first.panes.find(({ semanticPaneId }) => semanticPaneId === "pane.live-agent")?.name,
    ).toBe(adversarialName);
    expect(first.panes.find(({ semanticPaneId }) => semanticPaneId === adversarialStamp)).toEqual(
      expect.objectContaining({ role: null, name: null, type: null, windowPaneCount: 1 }),
    );
    expect(first.panes.filter(({ windowPaneCount }) => windowPaneCount === 2)).toHaveLength(2);
    expect(first.panes.filter(({ active }) => active)).toHaveLength(1);

    const projected = projectApplicationShellResource(first);
    const refreshed = projectApplicationShellResource(second);
    expect(projected.terminalInventory!.resources.map(({ id }) => id)).toEqual(
      refreshed.terminalInventory!.resources.map(({ id }) => id),
    );
    expect(
      projected.terminalInventory!.resources.map(({ attachability }) => attachability),
    ).toEqual(
      expect.arrayContaining([
        { status: "available", semanticPaneId: "pane.live-agent" },
        { status: "unavailable", reason: "invalid-semantic-stamp" },
        { status: "unavailable", reason: "not-single-pane-window" },
      ]),
    );
    const encoded = JSON.stringify(projected.terminalInventory);
    for (const runtimePaneId of runtimePaneIds) expect(encoded).not.toContain(runtimePaneId);
    expect(encoded).not.toMatch(/[@%][0-9]+/u);
    expect(encoded).not.toContain(first.dir);
    expect(encoded).not.toContain("sleep");
  });
});
