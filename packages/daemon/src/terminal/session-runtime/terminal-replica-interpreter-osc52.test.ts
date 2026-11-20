import { describe, expect, it } from "vitest";
import {
  REMOTE_CLIPBOARD_MAX_BYTES,
  type CanonicalTerminalReplicaUpdate,
  type RemoteClipboardEvent,
} from "@tmux-ide/contracts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const encode = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => Buffer.from(text).toString("base64");

function create() {
  const events: RemoteClipboardEvent[] = [];
  const updates: CanonicalTerminalReplicaUpdate[] = [];
  const interpreter = new TerminalReplicaInterpreter({
    generation,
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    incarnation: `${generation}:0`,
    cols: 20,
    rows: 3,
    onUpdate: (update) => updates.push(update),
    clipboardSink: { publish: (event) => events.push(event) },
  });
  const write = (text: string) => interpreter.enqueue({ type: "write", data: encode(text) });
  const reseed = (text: string) =>
    interpreter.enqueue({
      type: "reseed",
      cols: 20,
      rows: 3,
      chunks: [encode(text)],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
  return { interpreter, events, updates, write, reseed };
}

const row = (interpreter: TerminalReplicaInterpreter) =>
  interpreter
    .currentSnapshot()
    .grid[0]!.cells.map((cell) => cell.grapheme)
    .join("")
    .trimEnd();

describe("TerminalReplicaInterpreter OSC 52", () => {
  it("reports a clipboard write with the pane's address", async () => {
    const { interpreter, events, reseed, write } = create();
    try {
      await reseed("");
      await write(`a\x1b]52;c;${b64("hi")}\x07b`);
      expect(events).toEqual([
        {
          type: "clipboard.write",
          session: "workspace",
          paneId: "pane-a",
          incarnation: `${generation}:0`,
          bytes: 2,
          text: "hi",
        },
      ]);
      expect(row(interpreter)).toBe("ab");
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("reports from the first parser, before any reseed", async () => {
    const { interpreter, events, write } = create();
    try {
      await write(`\x1b]52;c;${b64("first")}\x07`);
      expect(events.map((event) => event.type === "clipboard.write" && event.text)).toEqual([
        "first",
      ]);
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("joins a sequence split across output chunks, including inside the payload", async () => {
    const { interpreter, events, reseed, write } = create();
    try {
      await reseed("");
      const sequence = `\x1b]52;c;${b64("split text")}\x1b\\`;
      for (const piece of [sequence.slice(0, 1), sequence.slice(1, 5), sequence.slice(5, 11)])
        await write(piece);
      expect(events).toEqual([]);
      await write(sequence.slice(11));
      expect(events.map((event) => event.type === "clipboard.write" && event.text)).toEqual([
        "split text",
      ]);
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("swallows a query: no report and nothing on screen", async () => {
    const { interpreter, events, reseed, write } = create();
    try {
      await reseed("");
      await write("x\x1b]52;c;?\x07y");
      expect(events).toEqual([]);
      expect(row(interpreter)).toBe("xy");
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("reports a too-large copy as refused, without its text", async () => {
    const { interpreter, events, reseed, write } = create();
    try {
      await reseed("");
      await write(`\x1b]52;c;${b64("x".repeat(REMOTE_CLIPBOARD_MAX_BYTES + 3))}\x07`);
      expect(events).toEqual([
        {
          type: "clipboard.refused",
          session: "workspace",
          paneId: "pane-a",
          incarnation: `${generation}:0`,
          bytes: REMOTE_CLIPBOARD_MAX_BYTES + 3,
          reason: "too-large",
        },
      ]);
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("drops invalid UTF-8, primary selection and a clear", async () => {
    const { interpreter, events, reseed, write } = create();
    try {
      await reseed("");
      await write(`\x1b]52;c;${Buffer.from([0xff, 0xfe]).toString("base64")}\x07`);
      await write(`\x1b]52;p;${b64("primary")}\x07`);
      await write("\x1b]52;c;\x07");
      expect(events).toEqual([]);
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("reports once from live output, never again from a reseed's replay", async () => {
    const { interpreter, events, reseed, write } = create();
    try {
      await reseed(`\x1b]52;c;${b64("replayed")}\x07`);
      expect(events).toEqual([]);
      await write(`\x1b]52;c;${b64("live")}\x07`);
      await reseed(`\x1b]52;c;${b64("replayed again")}\x07`);
      await write(`\x1b]52;c;${b64("after")}\x07`);
      expect(events.map((event) => event.type === "clipboard.write" && event.text)).toEqual([
        "live",
        "after",
      ]);
    } finally {
      await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    }
  });

  it("reports nothing after close", async () => {
    const { interpreter, events, reseed, write } = create();
    await reseed("");
    await interpreter.enqueue({ type: "close", reason: "pane-closed" });
    await write(`\x1b]52;c;${b64("late")}\x07`).catch(() => undefined);
    expect(events).toEqual([]);
  });
});
