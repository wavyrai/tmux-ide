import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { prepareMacosSshAccount } from "./macos-ssh-account.mjs";

const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
function host({ shell = "/bin/bash", after = "/bin/zsh", directory = "UserShell: /bin/zsh" } = {}) {
  const calls = [];
  return {
    calls,
    input: {
      env: hosted,
      platform: "darwin",
      uid: 501,
      userInfo: () => ({ uid: 501, username: "runner", shell }),
      freshUserInfo: () => ({ uid: 501, username: "runner", shell: after }),
      run: (file, args) => {
        calls.push([file, ...args]);
        return file === "/usr/bin/dscl" ? `${directory}\n` : "";
      },
    },
  };
}

test("switches a hosted runner account from bash to zsh and proves it in a fresh process", () => {
  const { calls, input } = host();
  const receipt = prepareMacosSshAccount(input);
  assert.deepEqual(calls, [
    [
      "/usr/bin/sudo",
      "-n",
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/runner",
      "UserShell",
      "/bin/zsh",
    ],
    ["/usr/bin/dscl", ".", "-read", "/Users/runner", "UserShell"],
  ]);
  assert.equal(receipt.success, true);
  assert.equal(receipt.before.shell, "/bin/bash");
  assert.equal(receipt.after.shell, "/bin/zsh");
  assert.equal(receipt.exportedShell, "/bin/zsh");
});

test("leaves an account that already uses zsh unchanged", () => {
  const { calls, input } = host({ shell: "/bin/zsh" });
  assert.equal(prepareMacosSshAccount(input).success, true);
  assert.deepEqual(calls, [["/usr/bin/dscl", ".", "-read", "/Users/runner", "UserShell"]]);
});

test("never touches an account outside a hosted macOS runner", () => {
  for (const change of [
    { env: {} },
    { env: { ...hosted, RUNNER_ENVIRONMENT: "self-hosted" } },
    { platform: "linux" },
    { uid: 0 },
    { userInfo: () => ({ uid: 501, username: "bad name", shell: "/bin/bash" }) },
  ]) {
    const { calls, input } = host();
    assert.throws(
      () => prepareMacosSshAccount({ ...input, ...change }),
      /Requires a disposable hosted macOS non-root account/,
    );
    assert.deepEqual(calls, [], "no command ran");
  }
});

test("fails when the directory or a fresh process still reports another shell", () => {
  for (const state of [{ directory: "UserShell: /bin/bash" }, { after: "/bin/bash" }]) {
    const { input } = host(state);
    assert.throws(() => prepareMacosSshAccount(input), /shell verification failed/);
  }
});

// #749: the weekly job required zsh and never switched the account, so it failed
// before the fixture on every run since 12 Oct 2026.
test("the macOS SSH qualification prepares the account before it requires zsh", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/development-instances.yml", import.meta.url),
    "utf8",
  );
  const job = workflow.slice(workflow.indexOf("\n  macos_ssh:"));
  const prepare = job.indexOf("node scripts/lib/macos-ssh-account.mjs");
  const require = job.indexOf('userInfo().shell!=="/bin/zsh"');
  assert.ok(prepare >= 0, "the job switches the account shell");
  assert.ok(require > prepare, "and only then requires zsh");
});
