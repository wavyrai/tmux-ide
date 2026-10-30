import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const builder = fileURLToPath(new URL("./assemble-local-app.mjs", import.meta.url));

// Node is opt-in: a half-specified Node, or a browser payload whose launcher still
// execs Resources/node, is refused before any supplied binary runs or the app exists.
for (const [name, options, message] of [
  ["--node without its license", ["--node", "CANDIDATE"], /--node and --node-license/],
  ["a license without --node", ["--node-license", "LICENSE"], /--node and --node-license/],
  ["a payload with the old Node launcher", ["--browser-payload", "OLD"], /launcher is outdated/],
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
        const old = join(root, "old-payload");
        await mkdir(old);
        await writeFile(
          join(old, "terminal-browser"),
          '#!/bin/sh\nexec "$root/../node" "$root/browser-launch.mjs" "$@"\n',
        );
        const args = options.map((value) =>
          ["CANDIDATE", "LICENSE"].includes(value) ? candidate : value === "OLD" ? old : value,
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

test("the browser launcher runs on the engine's Node mode, never Resources/node", async () => {
  const { TERMINAL_BROWSER_LAUNCHER: launcher } = await import("./browser-payload.mjs");
  assert.doesNotMatch(launcher, /\.\.\/node|Resources\/node/);
  assert.match(
    launcher,
    /^ *ELECTRON_RUN_AS_NODE=1 exec "\$engine\/Contents\/MacOS\/terminal-browser"/m,
  );
  // The launcher executes an engine only after the loader's own signature check.
  const loader = await readFile(new URL("./browser-runtime-load.mjs", import.meta.url), "utf8");
  const requirement = /^const requirement =\s*'([^']+)';/m.exec(loader)?.[1];
  assert.ok(requirement);
  assert.ok(launcher.includes(`requirement='${requirement}'`));
  assert.equal(launcher.match(/codesign --verify --deep --strict -R "\$requirement"/g)?.length, 2);
  assert.match(launcher, /shasum -a 256 .*\n.*= "\$digest" \] \|\| fail/);
});
