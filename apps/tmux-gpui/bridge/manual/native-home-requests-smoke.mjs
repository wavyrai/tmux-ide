// Card #703: daemon requests before Home and while Home sits idle, under the
// ignored Rust Home test (SMOKE_TEST names another, such as Session → Home). Owned scratch tmux server (-L) and daemon only;
// never the developer's.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createScratchFleet } from "../../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../fixture-child.mjs";
const { AbortSignal } = globalThis;

const [guiTestBinary] = process.argv.slice(2);
assert(
  guiTestBinary && isAbsolute(guiTestBinary),
  "Usage: node --import tsx native-home-requests-smoke.mjs ABS_GUI_TEST_BINARY",
);
const fleet = await createScratchFleet({
  sessions: Number(process.env.SMOKE_SESSIONS ?? 3),
  windowsPerSession: 1,
  slug: "home-requests",
  namedSocket: true,
});
let daemon, child;
try {
  daemon = await startDaemon(fleet);
  child = spawn(
    guiTestBinary,
    [
      "--ignored",
      "--nocapture",
      "--test-threads=1",
      process.env.SMOKE_TEST ?? "home_loads_with_few_requests_and_stays_quiet_when_idle",
    ],
    {
      env: {
        ...process.env,
        ...fleet.environment,
        TMUX_IDE_TEST_DAEMON_RECORD: join(fleet.daemonInfoDir, "daemon.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-262144);
      if (process.env.SMOKE_TRANSCRIPT) appendFileSync(process.env.SMOKE_TRANSCRIPT, chunk);
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(180000) });
  const line = output.split("\n").find((l) => l.startsWith("HOME_LIVE "));
  console.log(line ? JSON.stringify(JSON.parse(line.slice(10)), null, 1) : output.slice(-4000));
  assert.equal(signal, null);
  assert.equal(code, 0, output.replaceAll(daemon.record.authToken, "[redacted]"));
} finally {
  try {
    await stopFixtureChild(child);
  } finally {
    try {
      await daemon?.stop();
    } finally {
      await fleet.dispose();
    }
  }
}
