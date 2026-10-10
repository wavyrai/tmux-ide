// Real process termination at coordinated boundaries, using synthetic unsigned apps.
// This does not qualify power loss or the rename-to-pointer crash window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readlink,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installApp, rollbackApp } from "./install-transaction.mjs";

for (const phase of ["before", "after"]) {
  test(
    `SIGKILL ${phase} activation preserves a complete selected version`,
    { timeout: 10000 },
    async () => {
      const base = await realpath(await mkdtemp(join(tmpdir(), "gpui-install-kill-")));
      let child, closed;
      try {
        const stagedApp = join(base, "Stage.app"),
          installRoot = join(base, "managed");
        await mkdir(stagedApp, { mode: 0o700 });
        await writeFile(join(stagedApp, "payload"), "old");
        await installApp({
          stagedApp,
          installRoot,
          version: "1",
          verify: async (app) => (await readFile(join(app, "payload"), "utf8")) === "old",
        });
        await writeFile(join(stagedApp, "payload"), "new");
        const moduleUrl = new URL("./install-transaction.mjs", import.meta.url).href;
        // JSON values are embedded in JS arguments, never shell command text.
        const program = `
        import { installApp } from ${JSON.stringify(moduleUrl)};
        import { readFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const hold = () => new Promise(() => {
          setInterval(() => {}, 1000);
          process.stdout.write('BOUNDARY\\n');
        });
        await installApp({
          stagedApp: ${JSON.stringify(stagedApp)}, installRoot: ${JSON.stringify(installRoot)}, version: '2',
          verify: async (app) => (await readFile(join(app, 'payload'), 'utf8')) === 'new',
          ${phase === "before" ? "beforeActivate: hold," : ""}
        });
        ${phase === "after" ? "await hold();" : ""}
      `;
        child = spawn(process.execPath, ["--input-type=module", "-e", program], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        closed = once(child, "close");
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-4000);
        });
        await new Promise((done, reject) => {
          let output = "";
          const timer = setTimeout(() => finish(new Error("Boundary not reached")), 4000);
          const exited = () => finish(new Error(`Installer exited before boundary: ${stderr}`));
          const data = (chunk) => {
            output += chunk;
            if (output.includes("BOUNDARY\n")) finish();
          };
          function finish(error) {
            clearTimeout(timer);
            child.off("close", exited);
            child.stdout.off("data", data);
            error ? reject(error) : done();
          }
          child.once("close", exited);
          child.stdout.on("data", data);
        });
        assert.equal(child.kill("SIGKILL"), true);
        const [code, signal] = await closed;
        assert.equal(code, null);
        assert.equal(signal, "SIGKILL");
        assert.equal(
          await readFile(join(installRoot, "versions/1/TmuxIDE.app/payload"), "utf8"),
          "old",
        );
        if (phase === "before") {
          assert.equal(await readlink(join(installRoot, "current")), "versions/1/TmuxIDE.app");
          assert.equal(await readFile(join(installRoot, "current/payload"), "utf8"), "old");
          const retained = await readdir(join(installRoot, "versions"));
          assert.ok(retained.some((name) => name.startsWith(".pending-")));
          let verified = false;
          await assert.rejects(
            installApp({
              stagedApp,
              installRoot,
              version: "2",
              verify: async () => {
                verified = true;
                return true;
              },
            }),
            { code: "EEXIST" },
          );
          assert.equal(verified, false); // A stale lock is deliberately not stolen.
        } else {
          assert.equal(await readlink(join(installRoot, "current")), "versions/2/TmuxIDE.app");
          assert.equal(await readFile(join(installRoot, "current/payload"), "utf8"), "new");
          await rollbackApp({
            installRoot,
            verify: async (app) => (await readFile(join(app, "payload"), "utf8")) === "old",
          });
          assert.equal(await readlink(join(installRoot, "current")), "versions/1/TmuxIDE.app");
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (closed) await closed;
        await rm(base, { recursive: true, force: true });
      }
    },
  );
}
