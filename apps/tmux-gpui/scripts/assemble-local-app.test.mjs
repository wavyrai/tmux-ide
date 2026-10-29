import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const builder = fileURLToPath(new URL("./assemble-local-app.mjs", import.meta.url));

// Node is opt-in: a half-specified Node, or a Node-run payload without Node, is
// refused before any supplied binary runs or the app directory exists.
for (const [name, options, message] of [
  ["--node without its license", ["--node", "CANDIDATE"], /--node and --node-license/],
  ["a license without --node", ["--node-license", "LICENSE"], /--node and --node-license/],
  ["a browser payload without Node", ["--browser-payload", "PAYLOAD"], /bundled Node/],
])
  test(
    `assembly refuses ${name}`,
    { skip: process.platform !== "darwin" && "assembly is macOS only" },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gpui-assembly-options-"));
      try {
        const marker = join(root, "executed");
        const candidate = join(root, "candidate");
        await writeFile(candidate, `#!/bin/sh\nprintf executed > "${marker}"\n`, { mode: 0o755 });
        const app = join(root, "New.app");
        const args = options.map((value) =>
          ["CANDIDATE", "LICENSE"].includes(value) ? candidate : value,
        );
        await assert.rejects(
          run(process.execPath, [builder, candidate, join(root, "receipt.json"), app, ...args], {
            timeout: 15000,
          }),
          (error) => message.test(error.stderr),
        );
        await assert.rejects(access(app), { code: "ENOENT" });
        await assert.rejects(access(marker), { code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
