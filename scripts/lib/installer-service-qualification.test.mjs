import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../qualify-installer-service.mjs", import.meta.url), "utf8");
const installSource = source.slice(
  source.indexOf("function install("),
  source.indexOf("function pane("),
);
function fixture() {
  const calls = [];
  const receipt = { steps: [] };
  let owner = "original-service-instance";
  const install = vm.runInNewContext(installSource + "\ninstall", {
    assert,
    console: { log() {} },
    installer: "/reviewed/install.sh",
    prefix: "/private/prefix with spaces",
    evidence: "/evidence",
    join,
    writeFileSync() {},
    receipt,
    raw(file, args) {
      calls.push({ file, args: Array.from(args) });
      // Model the installer contract at its process boundary: a successful
      // version installation reconciles the daemon unless explicitly opted out.
      if (args.includes("--version") && !args.includes("--no-daemon-upgrade"))
        owner = "new-service-instance";
      return { status: 0, signal: null, stdout: "installed", stderr: "" };
    },
  });
  return { install, calls, receipt, owner: () => owner };
}

test("version qualification preserves the daemon until its explicit service restart", () => {
  const f = fixture();
  for (const name of ["first-install", "upgrade", "reinstall"]) {
    f.install(name, ["--version", "2.9.2"]);
    assert.equal(
      f.owner(),
      "original-service-instance",
      "installer reconciliation must not invalidate the explicit-restart oracle",
    );
    const call = f.calls.at(-1);
    assert.equal(call.file, "/bin/sh");
    assert.deepEqual(call.args.slice(0, 3), [
      "/reviewed/install.sh",
      "--prefix",
      "/private/prefix with spaces",
    ]);
    assert.ok(call.args.includes("--no-daemon-upgrade"));
    assert.equal(f.receipt.steps.at(-1).daemonUpgradeSuppressed, true);
  }
});

test("maintenance qualification keeps rollback and uninstall valid", () => {
  const f = fixture();
  for (const action of ["--rollback", "--uninstall"]) {
    f.install(action.slice(2), [action]);
    assert.deepEqual(f.calls.at(-1).args, [
      "/reviewed/install.sh",
      "--prefix",
      "/private/prefix with spaces",
      action,
    ]);
  }
});
