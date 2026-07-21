import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { appPath, executablePath } = JSON.parse(
  await readFile(join(packageRoot, "release", "package-path.json"), "utf8"),
);

const baseEnvironment = { ...process.env };
delete baseEnvironment.TMUX_IDE_RENDERER_URL;

async function runPackaged(environment = {}, timeoutMs = 20_000) {
  const child = spawn(executablePath, ["--smoke-test"], {
    env: { ...baseEnvironment, ...environment, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timeout);
  return { code, output };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing redirect test port"));
      else resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

let redirectRequests = 0;
let escapedRequests = 0;
const escaped = createServer((_request, response) => {
  escapedRequests += 1;
  response.end("redirect escaped its trusted renderer origin");
});
const escapedPort = await listen(escaped);
const redirecting = createServer((_request, response) => {
  redirectRequests += 1;
  response.writeHead(302, { location: `http://127.0.0.1:${escapedPort}/escaped` });
  response.end();
});
const redirectingPort = await listen(redirecting);
let redirectOutput;
try {
  ({ output: redirectOutput } = await runPackaged(
    { TMUX_IDE_RENDERER_URL: `http://127.0.0.1:${redirectingPort}/renderer` },
    5_000,
  ));
} finally {
  await Promise.all([close(redirecting), close(escaped)]);
}
if (redirectRequests !== 1 || escapedRequests !== 0) {
  throw new Error(
    `packaged redirect containment failed (redirect ${redirectRequests}, escaped ${escapedRequests})\n${redirectOutput}`,
  );
}

const { code, output } = await runPackaged();

if (!appPath || code !== 0 || !output.includes("tmux-ide desktop smoke ready")) {
  throw new Error(`packaged desktop smoke failed (exit ${code})\n${output}`);
}
console.log("Packaged desktop smoke passed");
