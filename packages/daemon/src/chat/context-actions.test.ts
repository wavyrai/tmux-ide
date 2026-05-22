import { describe, expect, it } from "bun:test";
import { ActionContractsZ } from "../command-center/actions/contract.ts";
import { ActionError } from "../command-center/actions/errors.ts";
import { chatContextCaptureTerminalHandler } from "./context-actions.ts";

describe("chat context actions", () => {
  it("captures terminal pane content with the expected tmux target", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await chatContextCaptureTerminalHandler(
      { sessionName: "alpha", paneId: "%2" },
      {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        execFile: async (file, args) => {
          calls.push({ file, args });
          if (args[0] === "display-message") return { stdout: "Dev Server\n", stderr: "" };
          return { stdout: "line 1\nline 2\n", stderr: "" };
        },
      },
    );

    expect(calls).toEqual([
      {
        file: "tmux",
        args: ["display-message", "-p", "-t", "alpha:%2", "#{pane_title}"],
      },
      {
        file: "tmux",
        args: ["capture-pane", "-t", "alpha:%2", "-p", "-e", "-S", "-5000"],
      },
    ]);
    expect(result).toEqual({
      pane: { id: "%2", title: "Dev Server" },
      content: "line 1\nline 2\n",
      capturedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(ActionContractsZ["chat.context.captureTerminal"].result.safeParse(result).success).toBe(
      true,
    );
  });

  it("maps missing session or pane failures to bad_request", async () => {
    try {
      await chatContextCaptureTerminalHandler(
        { sessionName: "missing", paneId: "%9" },
        {
          execFile: async () => {
            throw new Error("can't find pane");
          },
        },
      );
      throw new Error("expected capture to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).code).toBe("bad_request");
    }
  });
});
