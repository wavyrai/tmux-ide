import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The argv prefix that runs this tmux-ide's CLI: the bundled `bin/cli.js`,
 * or `bin/cli.ts` under the runtime's loader flags when run from source.
 * `here` must sit two directories below `packages/daemon/src`'s parent.
 */
export function resolveCliCommand(
  here: string = fileURLToPath(import.meta.url),
  runtime: { execPath: string; execArgv: readonly string[] } = process,
): string[] {
  if (basename(here) === "cli.js") return [runtime.execPath, here];
  const cli = join(dirname(here), "..", "..", "..", "..", "bin", `cli${extname(here)}`);
  return [runtime.execPath, ...runtime.execArgv, cli];
}
