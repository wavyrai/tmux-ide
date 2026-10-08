import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const requireFact = (value, message) => {
  if (!value) throw Error(message);
};
export const STYLED_SSH_TEST =
  "packages/daemon/src/tui/mirror/runtime/application-ssh-terminal-reconnect-renderer.test.tsx";

export function verifyStyledSshReceipt(receipt, { sourceSha256, binarySha256, exitCode, log }) {
  requireFact(exitCode === 0, "Bun did not exit successfully");
  const passes = [...log.matchAll(/^\s*(\d+) pass\s*$/gm)].map((m) => Number(m[1]));
  const failures = [...log.matchAll(/^\s*(\d+) fail\s*$/gm)].map((m) => Number(m[1]));
  requireFact(
    passes.length === 1 && passes[0] === 1 && failures.length === 1 && failures[0] === 0,
    "Expected exactly one passed test and no failures",
  );
  requireFact(
    !/^\s*[1-9]\d* (?:skip|todo|filtered out)/m.test(log),
    "Skipped or unselected required test",
  );
  requireFact(
    receipt?.passed === true && receipt.styledNative === true && !receipt.failure,
    "Missing successful styled-native receipt",
  );
  requireFact(
    receipt.sourceSha256 === sourceSha256 && receipt.result?.nativeBinarySha256 === binarySha256,
    "Source or native binary identity mismatch",
  );
  requireFact(
    Array.isArray(receipt.cleanupErrors) && receipt.cleanupErrors.length === 0,
    "Fixture cleanup errors",
  );
  requireFact(
    receipt.backendPortClosed === true &&
      receipt.sshCleanup?.closed === true &&
      receipt.sshCleanup.roots >= 1,
    "SSH/backend cleanup unverified",
  );
  const owned = receipt.nativeCleanup?.ownedPids;
  requireFact(
    receipt.nativeCleanup?.serverAbsent === true &&
      receipt.nativeCleanup.producerAbsent === true &&
      Array.isArray(owned) &&
      owned.length === 3 &&
      new Set(owned.map((p) => p.pid)).size === 3 &&
      owned.every((p) => /^\d+$/.test(String(p.pid)) && Number(p.pid) > 0 && p.absent === true),
    "Native cleanup unverified",
  );
  const result = receipt.result;
  requireFact(
    result.hostRetained === true &&
      Number.isSafeInteger(result.oldEpoch) &&
      result.newEpoch > result.oldEpoch &&
      Number.isSafeInteger(result.oldTunnelPid) &&
      Number.isSafeInteger(result.newTunnelPid) &&
      result.oldTunnelPid !== result.newTunnelPid,
    "Reconnect generation witness missing",
  );
  requireFact(
    result.exactInputHex === "5353485f494e5055545f34320d",
    "Recovered input witness mismatch",
  );
  requireFact(
    Array.isArray(receipt.completedFrames) &&
      receipt.completedFrames.length > 0 &&
      receipt.completedFrames.length <= 256,
    "Completed frames missing",
  );
  const trace = receipt.trace;
  requireFact(Array.isArray(trace), "Trace missing");
  const viewports = trace.filter((x) => x.type === "public-viewport");
  requireFact(
    JSON.stringify(viewports.map((x) => x.requested)) ===
      JSON.stringify([
        { cols: 40, rows: 9 },
        { cols: 24, rows: 9 },
        { cols: 40, rows: 9 },
      ]),
    "Public resize sequence missing",
  );
  requireFact(
    viewports.every(
      (x) =>
        x.native === `${x.requested.cols}|8|latest|top` &&
        x.completed?.cols === x.requested.cols &&
        x.completed.rows === 10 &&
        typeof x.geometryAuthorityClientId === "string" &&
        x.geometryAuthorityClientId.length > 0,
    ),
    "Native/completed geometry witness mismatch",
  );
  requireFact(
    JSON.stringify(trace.filter((x) => x.type === "public-window-selection").map((x) => x.pane)) ===
      JSON.stringify(["pane.ssh-second", "pane.ssh-view"]),
    "Public selection sequence missing",
  );
  const input = trace.find((x) => x.type === "selected-input-bytes");
  requireFact(
    input?.first === "46495253545f52455455524e5f494e505554" &&
      input.second === "5345434f4e445f494e505554",
    "Selected input bytes missing",
  );
  for (const marker of [
    "BEFORE_SSH",
    "RESIZE_NARROW",
    "SECOND_WINDOW",
    "DURING_SSH_OUTAGE",
    "AFTER_SSH_RECOVERY",
  ]) {
    requireFact(
      trace.some(
        (x) =>
          x.type === "styled-native-frame" &&
          x.marker === marker &&
          x.negativeControls >= (marker === "BEFORE_SSH" ? 7 : 8) &&
          x.raw &&
          x.actual,
      ),
      `Styled phase/corruption controls missing: ${marker}`,
    );
  }
  requireFact(
    trace.filter((x) => x.type === "transport-cleanup").length >= 2 &&
      trace.filter((x) => x.type === "transport-cleanup").every((x) => x.closed === true),
    "Forward cleanup missing",
  );
  return {
    passed: 1,
    skipped: 0,
    nativePids: owned.map((p) => Number(p.pid)),
    completedFrames: receipt.completedFrames.length,
  };
}

/** Copy only a same-user regular receipt from the fixture's fixed private /tmp namespace.
 * Receipt data never grants process signaling or deletion authority. */
export function collectStyledSshReceipt(log, destination) {
  const matches = [...log.matchAll(/^SSH viewer receipt: (.+)$/gm)];
  requireFact(matches.length === 1, "Expected exactly one emitted SSH receipt path");
  const root = matches[0][1].trim();
  requireFact(
    isAbsolute(root) &&
      dirname(root) === "/tmp" &&
      /^tmi-ssh-view-evidence-[A-Za-z0-9]+$/.test(basename(root)),
    "Untrusted receipt path",
  );
  const stat = lstatSync(root);
  requireFact(
    stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(),
    "Unowned receipt directory",
  );
  const actualRoot = realpathSync(root);
  requireFact(dirname(actualRoot) === realpathSync("/tmp"), "Receipt directory escaped /tmp");
  const fd = openSync(join(root, "receipt.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const file = fstatSync(fd);
    requireFact(
      file.isFile() &&
        file.uid === process.getuid() &&
        file.size > 0 &&
        file.size <= 32 * 1024 * 1024,
      "Invalid or oversized receipt file",
    );
    bytes = readFileSync(fd);
    requireFact(bytes.length === file.size, "Receipt changed during collection");
    const after = lstatSync(root);
    requireFact(
      after.dev === stat.dev && after.ino === stat.ino && realpathSync(root) === actualRoot,
      "Receipt directory changed",
    );
  } finally {
    closeSync(fd);
  }
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  return {
    receipt: JSON.parse(bytes.toString("utf8")),
    origin: { path: root, dev: stat.dev, ino: stat.ino, uid: stat.uid },
  };
}

/** Validate actual ancestry observations before sshd sees authorized_keys. */
export function validateStyledSshTempRoot(root, ancestors, uid) {
  requireFact(isAbsolute(root), "Absolute temporary root required");
  let expected = root;
  for (const entry of ancestors) {
    requireFact(
      entry.path === expected &&
        entry.directory === true &&
        (entry.uid === uid || entry.uid === 0) &&
        (entry.mode & 0o022) === 0,
      "Unsafe SSH temporary ancestry",
    );
    expected = dirname(expected);
  }
  requireFact(
    ancestors.length > 0 && ancestors.at(-1).path === "/",
    "Incomplete temporary ancestry",
  );
  const socket = join(root, "v-XXXXXX", "ssh-XXXXXX", "discovery.sock");
  requireFact(Buffer.byteLength(socket) <= 103, "SSH fixture socket path too long");
  return root;
}

export function inspectStyledSshTempRoot(path) {
  const root = realpathSync(path);
  const ancestors = [];
  let current = root;
  while (true) {
    const info = lstatSync(current);
    ancestors.push({
      path: current,
      directory: info.isDirectory() && !info.isSymbolicLink(),
      uid: info.uid,
      mode: info.mode,
    });
    if (current === "/") break;
    current = dirname(current);
  }
  validateStyledSshTempRoot(root, ancestors, process.getuid());
  return { root, ancestors };
}
