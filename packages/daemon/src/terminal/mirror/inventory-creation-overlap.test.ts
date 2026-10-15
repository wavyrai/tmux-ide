import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { projectTerminalRuntimeInventory } from "../../command-center/resources/terminal-runtime-inventory.ts";
import { WorkspaceTerminalInventoryRuntime } from "../attachments/native-runtime.ts";
import type { SessionRuntimeRegistry } from "../session-runtime/registry.ts";
import { SessionChannel } from "./session-channel.ts";
import {
  FIXTURE,
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
} from "./__tests__/simulated-channel.ts";

const separator = "|tmux-ide-field-v2|";

// Cold inventory uses its actual wire parser, not a mocked projection. Mirror
// descriptors and cold rows describe the same private session after creation.
function coldPaneRows(descriptors: readonly string[]): string {
  return (
    descriptors
      .map((line) => {
        const f = line.split("\t");
        return [
          f[17],
          f[10],
          f[8],
          f[0],
          f[18],
          f[19],
          f[1],
          f[11],
          f[9],
          f[4],
          f[15],
          f[14],
          "shell",
          f[12],
          "shell",
          f[13],
          f[5],
          f[16],
          f[6],
          "",
          "tmux-ide-pane-v2",
        ].join(separator);
      })
      .join("\n") + "\n"
  );
}

it("a pane/window read overlap rejects trusted discovery but cold fallback includes the created pane", async () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-inventory-overlap-"));
  const executablePath = join(root, "fake-tmux");
  writeFileSync(executablePath, "#!/bin/sh\nexit 99\n");
  chmodSync(executablePath, 0o755);
  const state = fixtureState();
  state.descriptorRows[2] = state.descriptorRows[2]!.replace("%3\t\t", "%3\tpane.gamma\t").replace(
    "\t\tzz-sim",
    "\twindow.test.two\tzz-sim",
  );
  let holdDescriptor = false;
  let held = false;
  let sim: SimulatedChannel | undefined;
  const channel = new SessionChannel({
    session: FIXTURE.session,
    createIo: (handlers) => {
      const reply = fixtureAutoReply(state);
      sim = new SimulatedChannel(handlers, (command) => {
        if (holdDescriptor && !held && command.includes("qa:@tmux_ide_pane_id")) {
          held = true;
          return null;
        }
        return reply(command);
      });
      return sim;
    },
    scheduleSync: () => undefined,
  });
  let runtime: WorkspaceTerminalInventoryRuntime | undefined;
  try {
    await channel.start();
    // Establish clean trusted discovery before introducing only the read overlap.
    await expect(channel.describeTrustedInventory("$1")).resolves.toMatchObject({
      runtimeSessionId: "$1",
    });
    const registry = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
    registry.add({ name: "workspace.overlap", sessionName: FIXTURE.session, projectDir: root });
    let trustedFailure: unknown;
    const trusted = vi.fn(async () => {
      try {
        return {
          inventory: await channel.describeTrustedInventory("$1"),
          token: Object.freeze({}),
        };
      } catch (error) {
        trustedFailure = error;
        throw error;
      }
    });
    const coldReads: string[] = [];
    runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: {
        executablePath,
        socketSelector: { kind: "name", name: "private-overlap" },
        trustedCwd: root,
      },
      commandExecutor: () => "",
      readCommandExecutor: async (_executable, rawArgv) => {
        const argv = rawArgv.slice(2);
        coldReads.push(argv[0]!);
        if (argv[0] === "list-sessions")
          return [FIXTURE.session, "$1", "tmux-ide-session-v2"].join(separator) + "\n";
        if (argv[0] === "list-panes") return coldPaneRows(state.descriptorRows);
        throw new Error(`Unexpected private inventory read: ${argv[0]}`);
      },
      sessionRuntimeRegistry: {
        describeTrustedSessionInventoryCandidate: trusted,
        isTrustedSessionInventoryCandidateCurrent: () => true,
        prewarmProofQualifiedSession: async () => undefined,
        retireSession: async () => undefined,
      } as unknown as SessionRuntimeRegistry,
    });
    await runtime.whenReady();
    holdDescriptor = true;
    const before = [...state.descriptorRows];
    const discovery = runtime.discoverTerminalRuntimeSession(FIXTURE.session);
    await vi.waitFor(() => expect(held).toBe(true));
    // The native mutation and stamps complete after list-panes executes but
    // before its reply reaches the discovery continuation's list-windows.
    state.descriptorRows = state.descriptorRows.map((line) => {
      const fields = line.split("\t");
      fields[19] = "3";
      return fields.join("\t");
    });
    const created = state.descriptorRows[2]!.split("\t");
    created[0] = "%4";
    created[1] = "pane.created";
    created[6] = "2";
    created[7] = "created";
    created[8] = "@3";
    created[16] = "window.test.three";
    state.descriptorRows.push(created.join("\t"));
    state.windowRows.push("@3\twindow.test.three\tcreated\t0\tcccc,200x50,0,0,4\t0\toff");
    sim!.reply(before);
    const snapshot = await discovery;
    expect(trusted).toHaveBeenCalledOnce();
    expect(trustedFailure).toBeInstanceOf(Error);
    expect((trustedFailure as Error).message).toMatch(/Incomplete linked pane membership/);
    expect(coldReads).toContain("list-panes");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.catalogIssue).toBeNull();
    expect(projectTerminalRuntimeInventory(snapshot!, 0).semanticPaneIds).toEqual([
      "pane.alpha",
      "pane.beta",
      "pane.created",
      "pane.gamma",
    ]);
  } finally {
    runtime?.dispose();
    await channel.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
