import { TextDecoder } from "node:util";
import { URL } from "node:url";
// Run with node --import tsx apps/tmux-gpui/bridge/direct-terminal-vectors.mjs.
// Independent cross-language vectors: production TS encoder and canonical hash.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeCompactSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
} from "../../../packages/core/src/terminal-delivery.ts";
import {
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
  applyTerminalReplicaPatch,
} from "../../../packages/core/src/terminal-replica.ts";
const cell = (
  grapheme = " ",
  width = 1,
  foreground = { kind: "default" },
  background = { kind: "default" },
  attributes = 0,
) => ({ grapheme, width, foreground, background, attributes });
const row = (cells, wrapped = false) => ({ cells, wrapped });
const base = {
  cols: 4,
  rows: 2,
  grid: [
    row([cell("A"), cell("é"), cell("界", 2), cell("", 0)]),
    row(
      Array.from({ length: 4 }, () => cell(" ")),
      true,
    ),
  ],
  history: [row(Array.from({ length: 4 }, () => cell("h")))],
  cursor: { x: 2, y: 1, hidden: false, style: "bar", blink: true },
  modes: {
    alternateScreen: false,
    applicationCursor: true,
    applicationKeypad: false,
    bracketedPaste: true,
    insert: false,
    origin: false,
    wraparound: true,
    mouseTracking: true,
    mouseProtocol: "drag",
    mouseEncoding: "sgr",
    synchronizedOutput: false,
  },
  placements: [
    { id: "image:1", kind: "kitty", row: 0, column: 0, columns: 2, rows: 1, contentDigest: "abc" },
  ],
  bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
};
const vectors = [];
function add(name, update, snapshot) {
  const bytes = encodeCompactSemanticTerminalUpdate(update);
  vectors.push({
    name,
    wire: new TextDecoder().decode(bytes),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    canonicalHash: snapshot
      ? hashTerminalReplicaSnapshot(snapshot)
      : hashTerminalReplicaTombstone(update.tombstone.reason),
  });
}
add("seed-unicode-wide-modes-placement", { frame: "seed", revision: 1, snapshot: base }, base);
const changed = row([
  cell("👩‍💻", 2, { kind: "rgb", value: 0xabcdef }, { kind: "indexed", index: 255 }, 255),
  cell("", 0),
  cell("é"),
  cell("\\\n"),
]);
const patch = {
  rows: [{ index: 1, row: changed }],
  historyDelta: { trim: 1, append: [base.grid[0]] },
  cursor: { ...base.cursor, x: 0, y: 0 },
};
const second = applyTerminalReplicaPatch(base, patch);
add("dirty-row-history-delta", { frame: "patch", baseRevision: 1, revision: 2, patch }, second);
const plainModes = { ...base.modes };
delete plainModes.mouseProtocol;
delete plainModes.mouseEncoding;
const metadata = { rows: [], modes: { ...plainModes, alternateScreen: true }, placements: [] };
const third = applyTerminalReplicaPatch(second, metadata);
add("metadata-only", { frame: "patch", baseRevision: 2, revision: 3, patch: metadata }, third);
const resize = {
  dimensions: { cols: 3, rows: 1 },
  rows: [{ index: 0, row: row([cell("r"), cell("s"), cell("t")]) }],
  history: [],
  cursor: { x: 0, y: 0, hidden: true, style: "underline", blink: false },
  placements: [],
  bootstrap: { kind: "painted-capture", hiddenState: "unknown" },
};
const fourth = applyTerminalReplicaPatch(third, resize);
add("resize", { frame: "patch", baseRevision: 3, revision: 4, patch: resize }, fourth);
add(
  "tombstone",
  { frame: "tombstone", baseRevision: 4, revision: 5, tombstone: { reason: "pane-closed" } },
  null,
);
const destination = new URL(
  "../upstream/crates/herdr-client/src/tmux_delivery/tests/vectors.json",
  import.meta.url,
);
writeFileSync(fileURLToPath(destination), JSON.stringify(vectors, null, 2) + "\n");
