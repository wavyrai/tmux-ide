import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyStyledSshReceipt, collectStyledSshReceipt } from "./styled-ssh-qualification.mjs";
const identity = {
  sourceSha256: "source",
  binarySha256: "binary",
  exitCode: 0,
  log: " 1 pass\n 0 fail\n",
};
function receipt() {
  return {
    passed: true,
    styledNative: true,
    sourceSha256: "source",
    cleanupErrors: [],
    backendPortClosed: true,
    sshCleanup: { closed: true, roots: 5 },
    nativeCleanup: {
      serverAbsent: true,
      producerAbsent: true,
      ownedPids: [1, 2, 3].map((pid) => ({ pid, absent: true })),
    },
    result: {
      nativeBinarySha256: "binary",
      hostRetained: true,
      oldEpoch: 1,
      newEpoch: 3,
      oldTunnelPid: 10,
      newTunnelPid: 11,
      exactInputHex: "5353485f494e5055545f34320d",
    },
    completedFrames: [{}],
    trace: [
      ...[40, 24, 40].map((cols) => ({
        type: "public-viewport",
        requested: { cols, rows: 9 },
        native: `${cols}|8|latest|top`,
        completed: { cols, rows: 10 },
        geometryAuthorityClientId: "client",
      })),
      ...["pane.ssh-second", "pane.ssh-view"].map((pane) => ({
        type: "public-window-selection",
        pane,
      })),
      {
        type: "selected-input-bytes",
        first: "46495253545f52455455524e5f494e505554",
        second: "5345434f4e445f494e505554",
      },
      ...[
        "BEFORE_SSH",
        "RESIZE_NARROW",
        "SECOND_WINDOW",
        "DURING_SSH_OUTAGE",
        "AFTER_SSH_RECOVERY",
      ].map((marker) => ({
        type: "styled-native-frame",
        marker,
        negativeControls: marker === "BEFORE_SSH" ? 7 : 8,
        raw: "record",
        actual: {},
      })),
      { type: "transport-cleanup", closed: true },
      { type: "transport-cleanup", closed: true },
    ],
  };
}
test("requires the single executed styled test with complete bound evidence", () => {
  assert.deepEqual(verifyStyledSshReceipt(receipt(), identity), {
    passed: 1,
    skipped: 0,
    nativePids: [1, 2, 3],
    completedFrames: 1,
  });
});
for (const [name, change] of [
  [
    "default ASCII",
    (r) => {
      r.styledNative = false;
    },
  ],
  [
    "wrong source",
    (r) => {
      r.sourceSha256 = "other";
    },
  ],
  [
    "wrong binary",
    (r) => {
      r.result.nativeBinarySha256 = "other";
    },
  ],
  [
    "cleanup error",
    (r) => {
      r.cleanupErrors.push("timeout");
    },
  ],
  [
    "live native PID",
    (r) => {
      r.nativeCleanup.ownedPids[0].absent = false;
    },
  ],
  [
    "duplicate native PID",
    (r) => {
      r.nativeCleanup.ownedPids[1].pid = 1;
    },
  ],
  [
    "missing resize",
    (r) => {
      r.trace.splice(1, 1);
    },
  ],
  [
    "missing window selection",
    (r) => {
      r.trace = r.trace.filter((x) => x.type !== "public-window-selection");
    },
  ],
  [
    "missing corruption control",
    (r) => {
      r.trace.find((x) => x.marker === "RESIZE_NARROW").negativeControls = 0;
    },
  ],
  [
    "unchanged epoch",
    (r) => {
      r.result.newEpoch = 1;
    },
  ],
  [
    "wrong recovered input",
    (r) => {
      r.result.exactInputHex = "";
    },
  ],
  [
    "no completed frames",
    (r) => {
      r.completedFrames = [];
    },
  ],
  [
    "unclosed SSH",
    (r) => {
      r.sshCleanup.closed = false;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const r = receipt();
    change(r);
    assert.throws(() => verifyStyledSshReceipt(r, identity));
  });
test("a skip, todo, filtered test or failed process cannot pass using a successful receipt", () => {
  for (const suffix of [" 1 skip\n", " 1 todo\n", " 1 filtered out\n"])
    assert.throws(() =>
      verifyStyledSshReceipt(receipt(), { ...identity, log: identity.log + suffix }),
    );
  assert.throws(() => verifyStyledSshReceipt(receipt(), { ...identity, exitCode: 1 }));
  assert.throws(() => verifyStyledSshReceipt(receipt(), { ...identity, log: "0 pass\n0 fail\n" }));
});
test("collector copies raw failed receipts without granting cleanup authority", () => {
  const root = mkdtempSync("/tmp/tmi-ssh-view-evidence-"),
    out = mkdtempSync("/tmp/ssh-collector-test-");
  try {
    const value = { passed: false, failure: "original failure" };
    writeFileSync(join(root, "receipt.json"), JSON.stringify(value));
    const result = collectStyledSshReceipt(
      `SSH viewer receipt: ${root}\n`,
      join(out, "receipt.json"),
    );
    assert.deepEqual(result.receipt, value);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "receipt.json"))), value);
    assert.equal(result.origin.uid, process.getuid());
    assert.throws(() => collectStyledSshReceipt("", join(out, "missing.json")));
    assert.throws(() =>
      collectStyledSshReceipt(
        `SSH viewer receipt: ${root}\nSSH viewer receipt: ${root}\n`,
        join(out, "multiple.json"),
      ),
    );
    rmSync(join(root, "receipt.json"));
    symlinkSync(join(out, "receipt.json"), join(root, "receipt.json"));
    assert.throws(() =>
      collectStyledSshReceipt(`SSH viewer receipt: ${root}\n`, join(out, "linked.json")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
test("collector rejects paths outside its fixed private receipt namespace", () => {
  for (const path of ["/etc", "/tmp/other", "relative", "/tmp/tmi-ssh-view-evidence-a/../other"])
    assert.throws(() => collectStyledSshReceipt(`SSH viewer receipt: ${path}\n`, "/unused"));
});
