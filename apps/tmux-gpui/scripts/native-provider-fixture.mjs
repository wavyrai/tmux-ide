// Explicit isolated daemon + native provider qualification. No desktop automation.
import { access, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
process.umask(0o077);
const options = {},
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--repo", "--tmux", "--cli", "--test-binary", "--output"].includes(args[i]) ||
    !args[i + 1] ||
    options[args[i]]
  )
    throw Error("Invalid arguments");
  options[args[i]] = args[i + 1];
}
for (const key of ["--repo", "--tmux", "--cli", "--test-binary", "--output"]) {
  if (!isAbsolute(options[key] ?? "")) throw Error(`Explicit absolute ${key} required`);
  if (key !== "--output") await access(options[key]);
}
await mkdir(options["--output"], { recursive: true, mode: 0o700 });
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key)
  )
    delete process.env[key];
process.env.PATH = dirname(options["--tmux"]) + ":" + (process.env.PATH ?? "");
const load = (p) => import(pathToFileURL(join(options["--repo"], p)).href);
const { createScratchFleet } = await load("scripts/lib/product-fixtures/scratch-fleet.ts");
const { startDaemon } = await load("scripts/lib/product-fixtures/daemon.ts");
let fleet, daemon;
try {
  fleet = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "native-provider",
    initialPaneCommand: {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('NATIVE PROVIDER READY\\n');process.stdin.resume()"],
    },
  });
  if (fleet.environment.TMUX_IDE_TMUX_BIN !== options["--tmux"])
    throw Error("Unexpected tmux binary");
  daemon = await startDaemon(fleet, { cliPath: options["--cli"] });
  const labels = await daemon.fleetLabels();
  if (labels.length !== 1) throw Error("Expected one owned fixture session");
  await daemon.promote(labels[0]);
  const result = await promisify(execFile)(
    options["--test-binary"],
    ["owned_daemon_native_provider_roundtrip", "--ignored", "--nocapture", "--test-threads=1"],
    {
      env: {
        ...process.env,
        ...fleet.environment,
        TMUX_IDE_NATIVE_PROVIDER_FIXTURE: "owned",
        TMUX_IDE_NATIVE_PROVIDER_RECORD: join(fleet.daemonInfoDir, "daemon.json"),
      },
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (!result.stdout.includes("test result: ok. 1 passed; 0 failed;"))
    throw Error("Expected native integration test did not run");
  await writeFile(join(options["--output"], "test.log"), result.stdout + result.stderr);
} catch (error) {
  await writeFile(
    join(options["--output"], "test.log"),
    (error.stdout ?? "") + (error.stderr ?? "") + "\n" + String(error),
  );
  process.exitCode = 1;
} finally {
  const cleanup = [];
  for (const [name, stop] of [
    ["daemon", () => daemon?.stop()],
    ["fleet", () => fleet?.dispose()],
  ]) {
    try {
      await stop();
      cleanup.push({ name, ok: true });
    } catch {
      cleanup.push({ name, ok: false });
      process.exitCode = 1;
    }
  }
  await writeFile(join(options["--output"], "cleanup.json"), JSON.stringify(cleanup, null, 2));
}
