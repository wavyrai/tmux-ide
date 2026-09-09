// Deterministic raw-input producer shared by every product adapter.
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function createProducerInputDecoder(inputMode, accept) {
  if (!["key", "line"].includes(inputMode)) throw new Error("Invalid inputMode");
  let sequence = 0;
  let pending = "";
  return (bytes) => {
    if (inputMode === "key") {
      for (const byte of bytes) if (byte === 0x78) accept(++sequence);
      return;
    }
    pending += bytes.toString("utf8");
    let match;
    while ((match = /CBINPUT:(\d{6})\r/.exec(pending))) {
      accept(Number(match[1]));
      pending = pending.slice(match.index + match[0].length);
    }
    pending = pending.slice(-256);
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = process.argv[2];
  const inputMode = process.argv[3] ?? "line";
  writeFileSync(`${receipt}.pid`, String(process.pid));
  let sequence = 0;
  function paint() {
    const cols = process.stdout.columns;
    const rows = process.stdout.rows;
    process.stdout.write(
      `\x1b[0m\x1b[2J\x1b[HCBENCH:${String(sequence).padStart(6, "0")}:${cols}x${rows}:END`,
    );
  }
  const decode = createProducerInputDecoder(inputMode, (next) => {
    sequence = next;
    appendFileSync(
      receipt,
      `${JSON.stringify({ sequence, atMs: Number(process.hrtime.bigint()) / 1e6 })}\n`,
    );
    paint();
  });
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.on("resize", paint);
  process.stdin.on("data", decode);
  paint();
}
