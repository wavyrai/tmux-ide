import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
if (!binary || !isAbsolute(binary)) {
  throw new Error(
    "Set TMUX_IDE_BOUNDARY_TEST_BINARY to the absolute path of the tmux binary to qualify.",
  );
}
const version = spawnSync(binary, ["-V"], { encoding: "utf8", timeout: 5000 });
if (version.status !== 0)
  throw new Error(`Cannot execute ${binary}: ${version.error ?? version.stderr}`);
console.log(
  JSON.stringify({
    binary,
    version: version.stdout.trim(),
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  }),
);
const cwd = fileURLToPath(new URL("../packages/daemon/", import.meta.url));
for (const [config, test] of [
  ["vitest.config.ts", "pane-feed-model.test.ts"],
  ["vitest.live.config.ts", "tmux-boundary-model-live.test.ts"],
  ["vitest.live.config.ts", "tmux-boundary-ordering-live.test.ts"],
]) {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", config, `src/terminal/mirror/${test}`],
    { cwd, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
