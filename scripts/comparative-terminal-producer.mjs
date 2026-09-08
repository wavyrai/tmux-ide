// Deterministic raw-input producer shared by every product adapter.
import { appendFileSync } from "node:fs";
const receipt = process.argv[2];
let sequence = 0;
let pending = "";
function paint() {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  process.stdout.write(
    `\x1b[0m\x1b[2J\x1b[HCBENCH:${String(sequence).padStart(6, "0")}:${cols}x${rows}:END`,
  );
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.on("resize", paint);
process.stdin.on("data", (bytes) => {
  pending += bytes.toString("utf8");
  let match;
  while ((match = /CBINPUT:(\d{6})\r/.exec(pending))) {
    sequence = Number(match[1]);
    appendFileSync(
      receipt,
      `${JSON.stringify({ sequence, atMs: Number(process.hrtime.bigint()) / 1e6 })}\n`,
    );
    pending = pending.slice(match.index + match[0].length);
    paint();
  }
  pending = pending.slice(-256);
});
paint();
