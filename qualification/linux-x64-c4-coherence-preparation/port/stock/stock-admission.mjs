import assert from "node:assert/strict";
export function admitStockCapabilities(run) {
  const version = run("display-message", "-p", "#{version}").trim();
  assert.equal(version, "3.7c");
  const raw = run("list-commands", "-F", "#{command_list_name}|#{command_list_usage}");
  const commands = new Map();
  for (const line of raw.trimEnd().split("\n")) {
    const at = line.indexOf("|");
    assert(at > 0, "Malformed stock command capability row");
    const name = line.slice(0, at);
    assert(!commands.has(name), "Duplicate stock command capability");
    commands.set(name, line.slice(at + 1));
  }
  for (const command of [
    "if-shell",
    "display-message",
    "capture-pane",
    "send-keys",
    "refresh-client",
    "attach-session",
    "kill-server",
  ])
    assert(commands.has(command), `Required stock command absent: ${command}`);
  assert(
    !commands.has("tmux-ide-operation"),
    "Journal-capable binary is not the stock counterpart",
  );
  const capture = commands.get("capture-pane");
  assert(!/\[[^\]]*R[^\]]*\]/u.test(capture), "Native grid capture advertised by stock candidate");
  assert(
    /\[[^\]]*N[^\]]*\]/u.test(capture),
    "Stock capture does not advertise trailing-row preservation",
  );
  assert(/\[[^\]]*F[^\]]*\]/u.test(commands.get("if-shell")), "Stock generation fence unsupported");
  return {
    version,
    nativeJournalAdvertised: false,
    nativeGridAdvertised: false,
    commandCapabilities: raw,
  };
}
export function assertStockObservation(status) {
  assert(status && status.method === "stock-hooks", "Pinned stock hooks must be available");
  assert.equal(status.cursor, null);
  assert.deepEqual(status.effects, []);
  assert.equal(status.capabilityVersion, 1);
  assert.equal(status.coverage, "partial");
  assert.deepEqual(status.commands, ["send-keys", "capture-pane"]);
  if (status.lastGap !== null) {
    assert(
      status.lastGap &&
        [
          "hooks-replaced",
          "retention-overflow",
          "uncertain-consume",
          "unresolved-target",
          "transport-replay-gap",
        ].includes(status.lastGap.reason),
    );
    assert.equal(status.lastGap.range, null, "Stock hooks cannot claim a native journal range");
    assert.equal(typeof status.lastGap.at, "string");
    assert(Number.isFinite(Date.parse(status.lastGap.at)));
  }
  if (status.droppedCount !== null) {
    assert.equal(typeof status.droppedCount, "string");
    assert(/^(0|[1-9][0-9]*)$/.test(status.droppedCount));
    assert(BigInt(status.droppedCount) <= 18446744073709551615n);
  }
}
export function stockObservationDiagnostics(initial, final) {
  assertStockObservation(initial);
  assertStockObservation(final);
  assert.equal(final.environmentId, initial.environmentId);
  assert.deepEqual(final.serverScope, initial.serverScope);
  if (initial.droppedCount === null) assert.equal(final.droppedCount, null);
  else if (final.droppedCount !== null)
    assert(BigInt(final.droppedCount) >= BigInt(initial.droppedCount));
  return {
    coverage: "partial",
    journalCompletenessClaim: false,
    initialGap: initial.lastGap,
    finalGap: final.lastGap,
    initialDroppedCount: initial.droppedCount,
    finalDroppedCount: final.droppedCount,
  };
}
