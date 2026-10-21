import { createHostedLiveSession } from "./hosted-live-session.ts";
import { createLiveProcessOutput } from "./live-process-output.ts";
import { COMPACT_HELPER_ENV } from "./snapshot-wire.ts";
import { KITTY_KNOWN_ENV, parseKnownDigests } from "./kitty-graphics.ts";
import { connectionSchema, readPrivateConfig } from "./config.ts";
import { MAX_INPUT_LINE } from "./input.ts";
import { createLiveDiagnostics } from "./live-diagnostics.ts";

const mode =
  process.argv[3] === "--interactive"
    ? "interactive"
    : process.argv[3] === "--catalog"
      ? "catalog"
      : "snapshot";
const transport = createLiveProcessOutput(
  process.stdout,
  process.env[COMPACT_HELPER_ENV] === "rle-v1" ? "rle-v1" : "legacy",
);
let session: ReturnType<typeof createHostedLiveSession> | undefined;
const stop = () => {
  void session?.dispose();
};
const outputFailed = () => {
  process.exitCode = 1;
  stop();
};
process.stdout.on("error", outputFailed);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  if (process.argv.length !== (mode === "snapshot" ? 3 : 4))
    throw Error("Usage: live.ts CONNECTION.json");
  session = createHostedLiveSession({
    config: connectionSchema.parse(readPrivateConfig(process.argv[2]!)),
    mode,
    knownDigests: parseKnownDigests(process.env[KITTY_KNOWN_ENV]),
    emit: transport.emit,
    diagnostic: (line) => process.stderr.write(line),
    drain: transport.drain,
    close: () => {
      process.stdin.destroy();
      transport.close();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    },
  });
  void session.done.then(() => {
    if (session?.failed) process.exitCode = 1;
  });
  if (mode === "interactive") {
    let buffer = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (end > MAX_INPUT_LINE) throw Error("Input rejected");
        await session.admit(JSON.parse(buffer.subarray(0, end).toString("utf8")));
        buffer = buffer.subarray(end + 1);
      }
      if (buffer.length > MAX_INPUT_LINE) throw Error("Input command too large");
    }
    // EOF is an orderly command barrier; explicit disposal cancels instead.
    await session.end();
  }
} catch {
  process.exitCode = 1;
  if (session) await session.dispose();
  else {
    createLiveDiagnostics((line) => process.stderr.write(line)).report("startup");
    transport.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
