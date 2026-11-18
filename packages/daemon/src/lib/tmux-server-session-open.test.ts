import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";
import { createNativeTmuxSessionOpener } from "./tmux-server-session-open.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const generation = "12345678-1234-4234-8234-123456789012";
const live = liveSessionIdForNativeIdentity("22", "$1", "1234");

type Row = { adopted?: string; window?: string; pane?: string; session?: string };
const row = ({
  adopted = "1",
  window = "window.promoted.a",
  pane = "pane.promoted.a",
  session = "$1",
}: Row = {}) => `22\t${session}\t1234\t${adopted}\t${window}\t${pane}\twork`;

/** An opener whose tmux answers `listing` and records every command. */
function fixture(listing: string, persistence: "durable" | "volatile" = "durable", aliases = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-open-")));
  roots.push(root);
  const registry = new WorkspaceRegistry({ dir: root, listSessions: () => [] });
  for (let i = 0; i < aliases; i++)
    registry.add({ name: `work${i || ""}`, sessionName: "work", projectDir: root, persistence });
  const commands: string[][] = [];
  const opener = createNativeTmuxSessionOpener({
    generation,
    registry,
    assertOpen: () => undefined,
    run: async (args) => {
      commands.push([...args]);
      if (args[0] === "list-panes" && args[1] === "-a") return listing;
      // Promotion is not under test here: its first command is enough to
      // show the opener went on to promote.
      throw new Error("promotion attempted");
    },
  });
  return { opener, commands };
}

describe("re-opening an already adopted session", () => {
  it("runs one tmux command and answers the durable alias", async () => {
    const { opener, commands } = fixture([row(), row({ pane: "pane.promoted.b" })].join("\n"));
    await expect(opener.openSession(live)).resolves.toEqual({
      workspaceName: "work",
      liveSessionId: live,
    });
    expect(commands).toHaveLength(1);
  });

  it.each([
    ["the session is not adopted", [row({ adopted: "" })], "durable", 1],
    ["a pane has no stamp (split since the last open)", [row(), row({ pane: "" })], "durable", 1],
    ["a pane stamp is reserved", [row({ pane: "terminal.discovered.x" })], "durable", 1],
    ["a window has no stamp", [row(), row({ window: "" })], "durable", 1],
    ["the only alias is volatile", [row()], "volatile", 1],
    ["the session has two aliases", [row()], "durable", 2],
  ] as const)("promotes as before when %s", async (_why, rows, persistence, aliases) => {
    const { opener, commands } = fixture(rows.join("\n"), persistence, aliases);
    await expect(opener.openSession(live)).rejects.toThrow();
    expect(commands.length).toBeGreaterThan(1);
  });

  it("promotes when a stamp holds a tab, whatever the field after the tab says", async () => {
    const { opener, commands } = fixture(row({ pane: "pane.promoted.a\tpane.promoted.b" }));
    await expect(opener.openSession(live)).rejects.toThrow();
    expect(commands.length).toBeGreaterThan(1);
  });

  it("never skips the agent admission of an agent open", async () => {
    const { opener, commands } = fixture([row(), row({ pane: "pane.promoted.b" })].join("\n"));
    await expect(
      opener.openAgent(live, { observedPaneId: "pane.promoted.a", observedAgentId: "agent.a" }),
    ).rejects.toThrow("promotion attempted");
    // The admission's own scan follows the identity read.
    expect(commands.length).toBeGreaterThan(1);
    expect(commands[1]![0]).toBe("if-shell");
  });

  it("refuses a live id that names no current session", async () => {
    const { opener, commands } = fixture(row({ session: "$9" }));
    await expect(opener.openSession(live)).rejects.toThrow(/no longer available/);
    expect(commands).toHaveLength(1);
  });
});
