// Installed as Resources/browser/browser-launch.mjs; the terminal-browser launcher runs it
// with the browser engine in Node mode (ELECTRON_RUN_AS_NODE=1), never a bundled Node.
import { spawn } from "node:child_process";
import { readFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrowserRuntime } from "./browser-runtime-load.mjs";

// In the engine's Node mode, fs treats *.asar paths as archives; the extractor must
// write the runtime's default_app.asar as a plain file.
process.noAsar = true;
const root = await realpath(dirname(fileURLToPath(import.meta.url)));
const cache = join(await realpath(homedir()), "Library", "Caches", "tmux-ide-browser-engine");
try {
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const metadata = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
  const app = await loadBrowserRuntime({
    destinationRoot: cache,
    archivePath: join(root, "browser-runtime.tar.gz"),
    metadata,
  });
  const engine = join(app, "Contents", "MacOS", "terminal-browser");
  const child = spawn(engine, [join(root, "cli", "dist", "main.js"), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      TERMINAL_BROWSER_DIST_ROOT: root,
      TMUX_IDE_BROWSER_ENGINE: engine,
      NATIVE_SCROLL_HELPER: join(root, "bin", "native-scroll-helper"),
    },
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`tmux-ide browser: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
} catch (error) {
  console.error(`tmux-ide browser: ${error.message}`);
  process.exitCode = 1;
}
