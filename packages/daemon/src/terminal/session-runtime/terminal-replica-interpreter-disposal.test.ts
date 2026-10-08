import { it, expect } from "vitest";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";
const generation = "00000000-0000-4000-8000-000000000001";
it.each(["invalid-projection", "invalid-projection-and-dispose", "throwing-listener"] as const)(
  "reseed ownership after %s",
  async (mode) => {
    const delegates: ReturnType<typeof createXtermTerminalInterpreterBackend>[] = [];
    const disposed: number[] = [];
    const updates: string[] = [];
    const interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 8,
      rows: 2,
      backendFactory(options) {
        const d = createXtermTerminalInterpreterBackend(options);
        const i = delegates.length;
        delegates.push(d);
        disposed.push(0);
        return new Proxy(d, {
          get(target, key) {
            if (key === "dispose")
              return () => {
                disposed[i]++;
                d.dispose();
                if (mode === "invalid-projection-and-dispose" && i === 1)
                  throw new Error("dispose secondary");
              };
            if (key === "project")
              return (...args: Parameters<typeof d.project>) => {
                const p = d.project(...args);
                return mode.startsWith("invalid-projection") && i === 2
                  ? { ...p, cursor: { ...p.cursor, x: 8 } }
                  : p;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      onUpdate(update) {
        updates.push(update.type);
        if (mode === "throwing-listener") throw new Error("listener control");
      },
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 2,
      chunks: [new TextEncoder().encode("OLD")],
      cursor: { x: 3, y: 0 },
      bootstrap: "authoritative-stream",
    });
    updates.length = 0;
    let failure: string | null = null;
    try {
      try {
        await interpreter.enqueue({
          type: "reseed",
          cols: 8,
          rows: 2,
          chunks: [new TextEncoder().encode("A")],
          cursor: { x: 1, y: 0 },
          bootstrap: "authoritative-stream",
        });
      } catch (e) {
        failure = String(e);
      }
      if (mode.startsWith("invalid-projection")) {
        expect(failure).toBe("TypeError: Malformed trusted terminal replica snapshot");
        expect(updates).toEqual([]);
        expect(
          interpreter
            .currentSnapshot()
            .grid[0]!.cells.slice(0, 3)
            .map((c) => c.grapheme)
            .join(""),
        ).toBe("OLD");
      } else {
        expect(failure).toBeNull();
        expect(updates).toEqual(["terminal.seed"]);
      }
      expect(disposed).toEqual([1, 1, 0]);
      await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
      expect(disposed).toEqual([1, 1, 1]);
    } finally {
      for (let i = 0; i < delegates.length; i++) if (disposed[i] === 0) delegates[i].dispose();
    }
  },
);
