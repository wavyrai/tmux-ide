import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function installFixture(t, { global, cli = "success", claude = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-postinstall-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
  copyFileSync(
    new URL("./postinstall.js", import.meta.url),
    join(root, "scripts", "postinstall.js"),
  );
  if (claude) mkdirSync(join(home, ".claude"));
  const marker = join(root, "invocation.json");
  if (cli !== "missing") {
    writeFileSync(
      join(root, "bin", "cli.js"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
      ${cli === "failure" ? 'console.error("fixture upgrade failed"); process.exit(1);' : 'console.log(JSON.stringify({ updated: false, reason: "no-running-daemon" }));'}
    `,
    );
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.npm_config_global;
  if (global !== undefined) env.npm_config_global = global;
  const result = spawnSync(process.execPath, [join(root, "scripts", "postinstall.js")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 45_000,
  });
  return { result, marker, home };
}

function assertInstallSucceeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

for (const global of [undefined, "false"]) {
  test(`local install (${String(global)}) does not invoke daemon upgrade`, (t) => {
    const { result, marker } = installFixture(t, { global });
    assertInstallSucceeded(result);
    assert.equal(existsSync(marker), false);
  });
}

test("global install checks only an existing daemon even without Claude integration", (t) => {
  const { result, marker, home } = installFixture(t, { global: "true" });
  assertInstallSucceeded(result);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), [
    "update",
    "--daemon",
    "--if-running",
    "--json",
  ]);
  assert.equal(existsSync(join(home, ".claude")), false);
});

test("global install with an absent compiled CLI remains successful", (t) => {
  const { result, marker } = installFixture(t, { global: "true", cli: "missing" });
  assertInstallSucceeded(result);
  assert.equal(existsSync(marker), false);
});

test("daemon upgrade failure does not fail installation or skip later integration", (t) => {
  const { result, marker, home } = installFixture(t, {
    global: "true",
    cli: "failure",
    claude: true,
  });
  assertInstallSucceeded(result);
  assert.equal(existsSync(marker), true);
  assert.match(result.stderr, /Run tmux-ide update --daemon after installation/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture upgrade failed/);
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
});
