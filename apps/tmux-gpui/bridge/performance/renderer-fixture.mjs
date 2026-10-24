// User-launched only in an isolated fixture pane. No desktop automation.
import process from "node:process";
import { once } from "node:events";
import { outputMarker } from "./renderer-probe.mjs";
import { writeOutput } from "./renderer-output.mjs";
if (process.env.TMUX_IDE_RENDERER_FIXTURE !== "1" || !process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error("Explicit isolated TTY fixture opt-in required");
process.stdin.setRawMode(true);
process.stdin.setEncoding("ascii");
let pending = "";
let outputBusy = false;
function stop() {
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?7h\r\n");
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdout.write("\x1b[2J\x1b[H\x1b[?7lFIXTURE READY\r\n");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\x03")) return stop();
  pending += chunk;
  if (pending.length > 4096) {
    pending = "";
    return;
  }
  for (let end; (end = pending.indexOf("\n")) >= 0; ) {
    const line = pending.slice(0, end).replace(/\r$/, "");
    pending = pending.slice(end + 1);
    // One bounded burst at a time; premature extra requests cannot queue unbounded work.
    if (outputBusy) continue;
    const burst = /^PROBE-BURST:([a-f0-9]{32})$/.exec(line);
    if (burst) {
      outputBusy = true;
      void writeOutput(burst[1], async (chunk) => {
        if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
      }).then(() => {
        outputBusy = false;
      });
      continue;
    }
    const request = /^PROBE-IN:([a-f0-9]{32})$/.exec(line);
    if (request) {
      process.stdout.write(`\x1b[H\x1b[2K${outputMarker(request[1])}`);
      continue;
    }
    const scroll = /^PROBE-PREPARE-SCROLL:([a-f0-9]{32})$/.exec(line);
    if (scroll) {
      // Preparation only: never time this output burst as a scroll operation.
      for (let row = 0; row < 500; row++)
        process.stdout.write(`\r\x1b[2K${outputMarker(scroll[1], row)}\r\n`);
      process.stdout.write("SCROLL READY\r\n");
    }
  }
});
