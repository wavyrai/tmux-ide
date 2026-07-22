import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runHeadlessDaemon } from "../../../packages/daemon/src/lib/headless-daemon.ts";

const expectedVersion = process.env.TMUX_IDE_DESKTOP_PRODUCT_VERSION;
process.env.TMUX_IDE_TEMPLATES_DIR ??= join(dirname(fileURLToPath(import.meta.url)), "templates");

void runHeadlessDaemon({
  json: true,
  ...(expectedVersion ? { expectedVersion } : {}),
}).catch((error) => {
  console.error(
    "tmux-ide desktop daemon failed",
    error instanceof Error ? error.message : "unknown startup failure",
  );
  process.exitCode = 1;
});
