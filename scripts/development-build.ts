/** Build API entry only; instance lifecycle commands are deliberately separate (D04). */
import {
  discoverDevelopmentWorktree,
  resolveDevelopmentInstance,
} from "../packages/daemon/src/lib/development-instance.ts";
import { buildDevelopmentInstance } from "../packages/daemon/src/lib/development-build-manager.ts";
const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1]!.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const bun = value("--bun");
if (!bun)
  throw new Error(
    "Usage: pnpm exec tsx scripts/development-build.ts --bun /absolute/pinned/bun [--worktree path] [--store path] [--name name]",
  );
const instance = resolveDevelopmentInstance({
  worktree: discoverDevelopmentWorktree(value("--worktree") ?? process.cwd()),
  store: value("--store"),
  name: value("--name"),
});
const build = await buildDevelopmentInstance(instance, { bun });
process.stdout.write(`${JSON.stringify(build)}\n`);
