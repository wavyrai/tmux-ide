import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";

import { ansiWorkloadPayload } from "./product-ansi-cursor-alt-screen.mjs";

const marker = process.argv[2];
if (typeof marker !== "string" || marker.length < 1 || marker.length > 256)
  throw new TypeError("ANSI fixture requires one bounded marker");
const completionPath = process.argv[3];
if (
  typeof completionPath !== "string" ||
  completionPath.length < 1 ||
  completionPath.length > 4_096 ||
  !completionPath.startsWith("/")
)
  throw new TypeError("ANSI fixture requires one bounded completion path");

const completionFd = openSync(completionPath, "a", 0o600);
const recordCompletion = (record) => {
  const line = `${JSON.stringify({
    version: 1,
    type: "performance.ansi-fixture-workload",
    ...record,
  })}\n`;
  writeSync(completionFd, line, null, "utf8");
};

let outputFailure = null;
process.stdout.on("error", (error) => {
  outputFailure ??= error;
});

const writeChunk = async (chunk) => {
  if (outputFailure) throw outputFailure;
  let callbackSettled = false;
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const accepted = process.stdout.write(chunk, (error) => {
    callbackSettled = true;
    if (error) rejectCallback(error);
    else resolveCallback();
  });
  if (!accepted && !callbackSettled) {
    await Promise.race([callback, new Promise((resolve) => process.stdout.once("drain", resolve))]);
  }
  await callback;
  if (outputFailure) throw outputFailure;
  return !accepted;
};

const writeOutput = async (text) => {
  let backpressureCount = 0;
  for (let offset = 0; offset < text.length; offset += 16 * 1024) {
    if (await writeChunk(text.slice(offset, offset + 16 * 1024))) backpressureCount += 1;
  }
  return backpressureCount;
};

const baselineBytes = `\x1b[3J\x1b[2J\x1b[H\x1b[2 q\x1b[?25h${marker}\x1b[2;1H`;
let outputQueue = Promise.resolve();
const enqueueOutput = (text, completion = null) => {
  outputQueue = outputQueue.then(async () => {
    try {
      const backpressureCount = await writeOutput(text);
      if (completion)
        recordCompletion({
          cycle: completion.cycle,
          ordinal: completion.ordinal,
          payloadBytes: Buffer.byteLength(text),
          payloadSha256: createHash("sha256").update(text).digest("hex"),
          status: "complete",
          backpressureCount,
        });
    } catch {
      if (completion)
        recordCompletion({
          cycle: completion.cycle,
          ordinal: completion.ordinal,
          payloadBytes: Buffer.byteLength(text),
          payloadSha256: createHash("sha256").update(text).digest("hex"),
          status: "error",
          backpressureCount: 0,
        });
      throw outputFailure ?? new Error("ANSI fixture stdout write failed");
    }
  });
  outputQueue.catch(() => {
    process.exitCode = 1;
    process.stdin.pause();
  });
};
const baseline = () => enqueueOutput(baselineBytes);

baseline();
if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
process.stdin.resume();

let cursor = 0;
let workload = 0;
process.stdin.on("data", (chunk) => {
  for (const byte of chunk) {
    if (byte === 98) baseline();
    else if (byte === 114)
      enqueueOutput(
        "\x1b[3J\x1b[H\x1b[2K\x1b[1;3;4;38;5;196;48;2;1;2;3mANSI_RICH界é\x1b[0m\x1b[2;129H\x1b[38;2;90;180;255;48;5;17;1;4mW界éZ\x1b[0m\x1b[4;7H\x1b[5 q\x1b[?25h",
      );
    else if (byte === 99) {
      cursor = (cursor + 1) % 30;
      const row = 2 + (cursor % 8);
      const col = 3 + (cursor % 20);
      const shape = 1 + (cursor % 6);
      enqueueOutput(`\x1b[${row};${col}H\x1b[${shape} q\x1b[?25h`);
    } else if (byte === 97)
      enqueueOutput("\x1b[?1049h\x1b[2J\x1b[HALT_SCREEN界é\x1b[8;12H\x1b[4 q\x1b[?25l");
    else if (byte === 110) enqueueOutput("\x1b[?1049l\x1b[0m\x1b[2;1H\x1b[2 q\x1b[?25h");
    else if (byte === 119) {
      workload += 1;
      enqueueOutput(ansiWorkloadPayload(marker, workload), {
        cycle: workload,
        ordinal: workload,
      });
    }
  }
});

process.on("exit", () => closeSync(completionFd));

setInterval(() => {}, 2_147_483_647);
