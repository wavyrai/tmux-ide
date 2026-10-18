import type {
  TerminalReplicaSnapshot,
  TerminalReplicaRow,
} from "../../../packages/contracts/src/terminal-replica.ts";
export type HistoryProof = {
  workspaceName: string;
  semanticPaneId: string;
  generation: string;
  incarnation: string;
  revision: number;
  stateHash: string;
};
export type HistoryFrame = { proof: HistoryProof; snapshot: TerminalReplicaSnapshot };
export type AnchorResult =
  | { status: "captured"; token: string }
  | { status: "resolved"; proof: HistoryProof; historyIndex: number }
  | { status: "unavailable" | "stale" | "lost" };
type Operation = { kind: "capture"; historyIndex: number } | { kind: "resolve"; token: string };
export type HistoryState =
  | "live"
  | "historical"
  | "restoring"
  | "lost"
  | "unavailable"
  | "unsupported";
const same = (a: HistoryProof, b: HistoryProof) =>
  a.workspaceName === b.workspaceName &&
  a.semanticPaneId === b.semanticPaneId &&
  a.generation === b.generation &&
  a.incarnation === b.incarnation &&
  a.revision === b.revision &&
  a.stateHash === b.stateHash;
/** Tab persistence uses only opaque owner tokens; transient bounded row references prove viewport identity. */
export function createHistoryRestoration(options: {
  read: (
    proof: HistoryProof,
    operation: Operation,
    signal: AbortSignal,
  ) => Promise<AnchorResult | null>;
  current: () => HistoryFrame | null;
  restore: (row: TerminalReplicaRow) => boolean;
  changed: () => void;
}) {
  let state: HistoryState = "live",
    token: string | null = null,
    serial = 0,
    pending: AbortController | undefined;
  let frames: {
      proof: HistoryProof;
      cols: number;
      rows: number;
      alternate: boolean;
      start: number;
      history: TerminalReplicaRow[];
      bytes: number;
    }[] = [],
    bytes = 0;
  let resolved: Extract<AnchorResult, { status: "resolved" }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    serial++;
    pending?.abort();
    pending = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    resolved = undefined;
  };
  const finish = (next: HistoryState) => {
    cancel();
    state = next;
    options.changed();
  };
  function apply() {
    if (!resolved) return;
    const frame = frames.find((frame) => same(frame.proof, resolved!.proof));
    if (!frame) return;
    const current = options.current();
    if (
      !current ||
      current.proof.generation !== frame.proof.generation ||
      current.proof.incarnation !== frame.proof.incarnation ||
      current.snapshot.cols !== frame.cols ||
      current.snapshot.rows !== frame.rows ||
      current.snapshot.modes.alternateScreen !== frame.alternate
    ) {
      finish("lost");
      return;
    }
    const row = frame.history[resolved.historyIndex - frame.start];
    finish(row && options.restore(row) ? "historical" : "lost");
  }
  return {
    publication: () => ({ state, token }),
    observe(frame: HistoryFrame | null) {
      if (!frame) {
        frames = [];
        bytes = 0;
        return;
      }
      if (!frames.some((old) => same(old.proof, frame.proof))) {
        const history: TerminalReplicaRow[] = [];
        let size = 0,
          start = frame.snapshot.history.length;
        for (
          let index = start - 1;
          index >= Math.max(0, frame.snapshot.history.length - 1000);
          index--
        ) {
          const row = frame.snapshot.history[index]!;
          const rowBytes = Buffer.byteLength(JSON.stringify(row));
          if (size + rowBytes > 2 * 1024 * 1024) break;
          size += rowBytes;
          history.push(row);
          start = index;
        }
        history.reverse();
        frames.push({
          proof: frame.proof,
          cols: frame.snapshot.cols,
          rows: frame.snapshot.rows,
          alternate: frame.snapshot.modes.alternateScreen,
          start,
          history,
          bytes: size,
        });
        bytes += size;
        while (frames.length > 4 || bytes > 4 * 1024 * 1024) bytes -= frames.shift()!.bytes;
      }
      apply();
    },
    capture(index: number | null) {
      cancel();
      token = null;
      state = index === null ? "live" : "historical";
      const frame = options.current();
      if (index === null || !frame) {
        options.changed();
        return;
      }
      const revision = serial,
        controller = new AbortController();
      pending = controller;
      void options
        .read(frame.proof, { kind: "capture", historyIndex: index }, controller.signal)
        .then((result) => {
          if (revision !== serial) return;
          token = result?.status === "captured" ? result.token : null;
          if (!result) state = "unsupported";
          else if (result.status !== "captured")
            state = result.status === "lost" ? "lost" : "unavailable";
          options.changed();
        })
        .catch(() => {
          if (revision === serial) {
            state = "unavailable";
            options.changed();
          }
        });
      options.changed();
    },
    restore(saved: string) {
      cancel();
      token = saved;
      state = "restoring";
      const frame = options.current();
      if (!frame) {
        finish("unavailable");
        return;
      }
      const revision = serial,
        controller = new AbortController();
      pending = controller;
      timer = setTimeout(() => {
        if (revision === serial) finish("unavailable");
      }, 3000);
      void options
        .read(frame.proof, { kind: "resolve", token: saved }, controller.signal)
        .then((result) => {
          if (revision !== serial) return;
          if (!result) {
            finish("unsupported");
            return;
          }
          if (result.status !== "resolved") {
            finish(result.status === "lost" ? "lost" : "unavailable");
            return;
          }
          resolved = result;
          apply();
        })
        .catch(() => {
          if (revision === serial) finish("unavailable");
        });
      options.changed();
    },
    lost() {
      token = null;
      finish("lost");
    },
    unavailable() {
      token = null;
      finish("unavailable");
    },
    live() {
      cancel();
      token = null;
      state = "live";
      options.changed();
    },
    dispose() {
      cancel();
      frames = [];
      bytes = 0;
      token = null;
    },
  };
}
