import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBundledTmux } from "../../../packages/daemon/src/lib/bundled-tmux.ts";
import { runHeadlessDaemon } from "../../../packages/daemon/src/lib/headless-daemon.ts";

// The packaged daemon also uses ordinary tmux discovery helpers. Make their
// bare tmux invocations resolve the same verified payload on Finder launches.
const bundledTmux = resolveBundledTmux([fileURLToPath(import.meta.url)]);
if (bundledTmux) {
  process.env.PATH = [dirname(bundledTmux), process.env.PATH].filter(Boolean).join(delimiter);
}

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
  // IdeError converges structural refusals (protocol/identity mismatch, usage)
  // on exitCode 2; the supervisor classifies that as fatal instead of retrying.
  const exitCode = /** @type {{ exitCode?: unknown }} */ (error ?? {}).exitCode;
  process.exitCode =
    typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode > 0 ? exitCode : 1;
});
