// Rebuilds the embedded demo font subsets (see build.py). Needs `uv` on PATH.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const geist = join(realpathSync(join(here, "../../node_modules/geist")), "dist/fonts/geist-mono");
const result = spawnSync(
  "uvx",
  ["--from", "fonttools[woff]==4.*", "python", "-I", join(here, "build.py"), geist],
  { stdio: "inherit" },
);
if (result.error)
  throw new Error(`demo:font needs uv (https://docs.astral.sh/uv/): ${result.error.message}`);
process.exit(result.status ?? 1);
