import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { appPath, executablePath } = JSON.parse(
  await readFile(join(packageRoot, "release", "package-path.json"), "utf8"),
);

const child = spawn(executablePath, ["--smoke-test"], {
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timeout);

if (!appPath || code !== 0 || !output.includes("tmux-ide desktop smoke ready")) {
  throw new Error(`packaged desktop smoke failed (exit ${code})\n${output}`);
}
console.log("Packaged desktop smoke passed");
