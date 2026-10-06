import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
const expectedNative = process.env.TMUX_IDE_ORACLE_EXPECT_NATIVE;
if (!binary || !isAbsolute(binary)) {
  throw new Error(
    "Set TMUX_IDE_BOUNDARY_TEST_BINARY to the absolute path of the tmux binary to qualify.",
  );
}
if (expectedNative !== "0" && expectedNative !== "1") {
  throw new Error(
    "Set TMUX_IDE_ORACLE_EXPECT_NATIVE to 1 for bundled physical capture or 0 for stock compatibility.",
  );
}
const version = spawnSync(binary, ["-V"], { encoding: "utf8", timeout: 5000 });
if (version.status !== 0)
  throw new Error(`Cannot execute ${binary}: ${version.error ?? version.stderr}`);
console.log(
  JSON.stringify({
    binary,
    expectedNativePhysicalCapture: expectedNative === "1",
    version: version.stdout.trim(),
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  }),
);
const cwd = fileURLToPath(new URL("../packages/daemon/", import.meta.url));
for (const [config, test] of [
  ["vitest.config.ts", "src/terminal/mirror/pane-feed-model.test.ts"],
  ["vitest.config.ts", "src/terminal/mirror/control-channel-model.test.ts"],
  ["vitest.config.ts", "src/terminal/mirror/session-channel-model.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/tmux-boundary-model-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/tmux-boundary-ordering-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/control-collector-retirement-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/control-owned-pause-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/session-channel-cancellation-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/native-physical-cell-oracle-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/canonical-resize-publication-live.test.ts"],
  ["vitest.live.config.ts", "src/tui/mirror/runtime/terminal-input-ordering-live.test.ts"],
  ["vitest.live.config.ts", "src/tui/mirror/runtime/terminal-native-input-death-live.test.ts"],
  [
    "vitest.live.config.ts",
    "src/tui/mirror/runtime/terminal-input-session-replacement-live.test.ts",
  ],
]) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", config, test], {
    cwd,
    env: { ...process.env, TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY: binary },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const evidence = join(mkdtempSync(join(tmpdir(), "tmux-boundary-wire-")), "evidence");
console.log(`Control scheduler wire evidence: ${evidence}`);
const wire = spawnSync(
  "python3",
  [
    fileURLToPath(new URL("./check-tmux-control-barriers.py", import.meta.url)),
    binary,
    "--output",
    evidence,
  ],
  { env: process.env, stdio: "inherit" },
);
if (wire.error) throw wire.error;
if (wire.status !== 0) process.exit(wire.status ?? 1);
