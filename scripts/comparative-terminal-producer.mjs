// Deterministic raw-input producer shared by every product adapter.
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TYPING_SCENARIO } from "./comparative-terminal-scenario.mjs";
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

export function typingPaint(cols, rows, sequence, flood) {
  const lines = [
    `CBENCH:${String(sequence).padStart(6, "0")}:${cols}x${rows}:END`,
    `CBFLOOD:${String(flood).padStart(6, "0")}:END`,
    "styled sentinel",
  ];
  let bytes = "\x1b[?7l\x1b[?25h";
  for (let y = 0; y < rows; y++) {
    bytes +=
      `\x1b[${y + 1};1H` +
      (y === 2
        ? "\x1b[0;1;38;2;230;245;255;48;2;52;86;120m"
        : "\x1b[0;38;2;210;220;230;48;2;20;30;40m") +
      (lines[y] ?? "").padEnd(cols).slice(0, cols);
  }
  return bytes + "\x1b[0m\x1b[4;3H\x1b[?7h";
}
export function floodPaint(flood) {
  const bytes = `\x1b[2;1H\x1b[0;38;2;210;220;230;48;2;20;30;40mCBFLOOD:${String(flood).padStart(6, "0")}:END\x1b[0m\x1b[4;3H`;
  // Ignored private OSC payload fixes bytes per offered tick without changing cells.
  return bytes + "\x1b]777;" + "p".repeat(512 - Buffer.byteLength(bytes) - 7) + "\x07";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = process.argv[2];
  const inputMode = process.argv[3] ?? "line";
  const scenario = process.argv[4];
  let flood = 0,
    timer;
  const record = (value) => appendFileSync(receipt, `${JSON.stringify(value)}\n`);
  writeFileSync(`${receipt}.pid`, String(process.pid));
  let sequence = 0;
  function paint() {
    const cols = process.stdout.columns;
    const rows = process.stdout.rows;
    if (scenario) {
      process.stdout.write(typingPaint(cols, rows, sequence, flood));
      return;
    }
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
  let control = "";
  process.stdin.on("data", (data) => {
    if (!scenario) {
      decode(data);
      return;
    }
    control += data.toString("utf8");
    let end;
    while ((end = control.indexOf("\r")) >= 0) {
      const line = control.slice(0, end);
      control = control.slice(end + 1);
      if (line === "CBSTART" && !timer && scenario === "flood-typing") {
        const started = performance.now();
        const tick = () => {
          flood++;
          const offeredAtMs = started + flood * TYPING_SCENARIO.floodIntervalMs;
          const atMs = performance.now();
          const writable = process.stdout.write(floodPaint(flood));
          record({
            kind: "flood",
            flood,
            offeredAtMs,
            atMs,
            scheduleDelayMs: atMs - offeredAtMs,
            writable,
          });
          if (flood < TYPING_SCENARIO.floodTicks)
            timer = setTimeout(tick, Math.max(0, started + (flood + 1) * 100 - performance.now()));
        };
        timer = setTimeout(tick, 100);
      } else if (/^CBINPUT:\d{6}$/.test(line)) {
        record({ kind: "input-token", hex: Buffer.from(line + "\r").toString("hex") });
        decode(Buffer.from(line + "\r"));
      } else if (line !== "CBSTART") throw Error("Unexpected typing input token");
    }
    if (control.length > 256) throw Error("Input buffer exceeded");
  });
  paint();
}
