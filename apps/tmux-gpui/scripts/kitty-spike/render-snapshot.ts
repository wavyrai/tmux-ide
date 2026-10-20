/**
 * SPIKE: replay a recorded control-mode transcript through the daemon's
 * replica interpreter and write a preview snapshot with its kitty images.
 *
 *   bun render-snapshot.ts TRANSCRIPT OUT.json [cols rows]
 *   cargo run -p herdr-gpui --bin tmux-ide-gpui -- --tmux-snapshot OUT.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseControlLine } from "../../../../packages/daemon/src/terminal/protocol/control.ts";
import { resolveKittyPlacements } from "../../../../packages/core/src/kitty-placeholders.ts";
import { TerminalReplicaInterpreter } from "../../../../packages/daemon/src/terminal/session-runtime/terminal-replica-interpreter.ts";

const [transcript, out, colsArg = "80", rowsArg = "24"] = process.argv.slice(2);
if (!transcript || !out)
  throw new Error("usage: render-snapshot.ts TRANSCRIPT OUT.json [cols rows]");
const cols = Number(colsArg);
const rows = Number(rowsArg);
const generation = "00000000-0000-4000-8000-00000000c0de";
const interpreter = new TerminalReplicaInterpreter({
  generation,
  workspaceName: "kitty-spike",
  semanticPaneId: "pane",
  incarnation: `${generation}:0`,
  cols,
  rows,
});
await interpreter.enqueue({
  type: "reseed",
  cols,
  rows,
  chunks: [],
  cursor: { x: 0, y: 0 },
  bootstrap: "authoritative-stream",
});
let wire = 0;
let inside = false;
for (const line of readFileSync(transcript).toString("latin1").split("\n")) {
  const event = parseControlLine(line.replace(/\r$/u, ""), inside);
  if (event.kind === "begin") inside = true;
  if (event.kind === "end" || event.kind === "error") inside = false;
  if (event.kind !== "output") continue;
  wire += line.length + 1;
  void interpreter.enqueue({ type: "write", data: event.data });
}
await interpreter.whenIdle();
const snapshot = interpreter.currentSnapshot();
const state = interpreter.currentGraphics();
const placements = state ? resolveKittyPlacements(snapshot.grid, state) : [];
const store = interpreter.kittyImages();
const images = [...new Set(placements.map((p) => p.digest))].flatMap((digest) => {
  const image = store.imageByDigest(digest);
  return image
    ? [
        {
          digest,
          format: image.format,
          width: image.width,
          height: image.height,
          data: Buffer.from(image.data).toString("base64"),
        },
      ]
    : [];
});
writeFileSync(out, JSON.stringify({ ...snapshot, kittyGraphics: { placements, images } }));
console.log(
  JSON.stringify(
    {
      wireBytes: wire,
      placements,
      images: images.map(({ data, ...rest }) => ({ ...rest, bytes: data.length })),
    },
    null,
    1,
  ),
);
