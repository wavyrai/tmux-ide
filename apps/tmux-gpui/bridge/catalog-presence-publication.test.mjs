// Execute the production publication owner, without launching a daemon or helper.
// This isolates ACK ownership; actual helper retirement remains a live-fixture gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import ts from "typescript";
import { preparePublication, createPublicationDeduplicator } from "./prepared-publication.ts";
import { createNativePublicationWriter } from "./native-publication.ts";

const source = await readFile(new URL("./browser.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("browser.ts", source, ts.ScriptTarget.Latest, true);
const owner = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "publish",
);
assert.ok(owner, "production publication owner exists");
const executable = ts.transpileModule(owner.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(overrides = {}) {
  const empty = { publication: () => null, cancel() {} };
  const events = [];
  const writer = createNativePublicationWriter("legacy", (line) => {
    events.push(JSON.parse(line));
    return true;
  });
  const context = vm.createContext({
    Buffer,
    setTimeout,
    clearTimeout,
    workspaceFleetAgents: { ...empty, sync() {} },
    sessionHistory: empty,
    sessionTabs: { ...empty, keys: () => [] },
    sessionCreate: empty,
    palette: empty,
    attention: empty,
    appearance: empty,
    process: {
      stdout: {
        write(line) {
          events.push(JSON.parse(line));
          return true;
        },
      },
    },
    paneChoices: () => [{ id: "pane-a", windowId: "window-a" }],
    request: 1,
    catalog: {},
    stopped: false,
    foreground: true,
    surface: "workspace",
    selectedSession: "session-a",
    selectedPane: null,
    panes: [{ semanticPaneId: "pane-a", liveSessionId: "session-a" }],
    layouts: [],
    kittyPlacements: [],
    fleet: null,
    acceptSessionVisit: null,
    observingTabs: false,
    selectedFleet: null,
    homePhase: "live",
    status: "Choose a pane or window",
    active: undefined,
    appliedPresenceRevision: 1,
    presenceRevision: 2,
    connection: "fixture",
    sequence: 0,
    sessions: [],
    agentPublication: null,
    sessionHistoryRejected: null,
    paletteSelectionRejected: null,
    attentionSelectionRejected: null,
    sessionTabResult: null,
    workspaceFleetAgentRejected: null,
    sessionCatalogComplete: true,
    initialPane: "pane-a",
    historySaveFailed: false,
    historyOffset: 0,
    inputReady: false,
    inputTargetRejected: false,
    inputTargets: null,
    snapshot: null,
    splitGesture: null,
    resizeGesture: null,
    resizeGestureSupported: false,
    machines: null,
    machineMessage: null,
    MAX_FRAME: 8 * 1024 * 1024,
    preparePublication,
    admitPublication: createPublicationDeduplicator(),
    forceNativePublication: false,
    nativeFrameContext: () => ({
      identity: "fixture",
      connection: context.connection,
      request: context.request,
    }),
    writePublication: (publication) => writer.write(publication, publication.context),
    localCreateProof: null,
    revokeLocalCreateOffer() {},
    localSetup: null,
    localSetupContext: () => false,
    retainedFrames: { retain() {} },
    historyDrains: new Map(),
    historyDrainEpoch: 0,
    retainedHistory: new Map(),
    retainedPreview: null,
    clearRetainedPreview() {},
    frameProof: () => null,
    diagnosticTmuxVersion: () => null,
    homeRecovery: { publication: () => null },
    homeAgentFilter: null,
    selectionIdentity: null,
    blocked: false,
    pending: null,
    ...overrides,
  });
  vm.runInContext(executable, context);
  return {
    context,
    publish() {
      vm.runInContext("publish()", context);
      return events.at(-1);
    },
  };
}

test("completed metadata Workspace acknowledges foreground after helper retirement without granting input", () => {
  const f = fixture({ foreground: false, presenceRevision: 1 });
  assert.equal(f.publish().presenceRevision, 1);
  f.context.foreground = true;
  f.context.presenceRevision = 2;
  const next = f.publish();
  assert.equal(next.presenceRevision, 2, "no terminal helper exists to acknowledge this revision");
  assert.equal(next.preferredPane, "pane-a");
  assert.equal(next.snapshot, null);
  assert.equal(next.selectedPane, null);
  assert.equal(next.inputReady, false);
});

test("metadata helper retirement boundary cannot leave completed Workspace acknowledgement stranded", () => {
  const f = fixture({ active: { catalogOnly: true } });
  assert.equal(f.publish().presenceRevision, 1, "helper still owned before retirement");
  f.context.active = undefined;
  assert.equal(f.publish().presenceRevision, 2, "retired metadata owner must acknowledge locally");
});

test("live terminal helper retains acknowledgement ownership until its own ACK", () => {
  const f = fixture({ active: { catalogOnly: false }, selectedPane: "pane-a" });
  assert.equal(f.publish().presenceRevision, 1);
  f.context.appliedPresenceRevision = 2; // Represents validated current helper ACK.
  assert.equal(f.publish().presenceRevision, 2);
  assert.equal(f.publish().inputReady, false, "presence ACK alone never grants input");
});

test("Home without a helper already acknowledges local presence", () => {
  const f = fixture({ surface: "home", sessionCatalogComplete: false, selectedSession: null });
  assert.equal(f.publish().presenceRevision, 2);
});

test("completed catalog publishes its ACK after synchronously retiring the actual metadata owner", async () => {
  let killed = false;
  const f = fixture({
    active: {
      catalogOnly: true,
      child: {
        kill() {
          killed = true;
        },
      },
      done: Promise.resolve(),
    },
  });
  const retire = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "retire",
  );
  assert.ok(retire);
  vm.runInContext(
    ts.transpileModule(retire.getText(parsed), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    f.context,
  );
  let completion;
  function visit(node) {
    if (ts.isBlock(node)) {
      const index = node.statements.findIndex(
        (statement) => statement.getText(parsed) === 'status = "Choose a pane or window";',
      );
      if (index >= 0)
        completion = node.statements
          .slice(index, index + 3)
          .map((statement) => statement.getText(parsed))
          .join("\n");
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(completion, "actual completed catalog publication sequence exists");
  vm.runInContext(completion, f.context);
  assert.equal(killed, true);
  assert.equal(f.context.active, undefined);
  assert.equal(
    f.context.appliedPresenceRevision,
    2,
    "first completed catalog publication must carry current ACK",
  );
  await Promise.resolve();
});

test("incomplete or authority-bearing Workspace cannot locally acknowledge presence", () => {
  for (const overrides of [
    { sessionCatalogComplete: false },
    { catalog: null },
    { selectedSession: null },
    { selectedPane: "pane-a" },
    { snapshot: {} },
    { inputReady: true },
    { active: { catalogOnly: false } },
  ]) {
    const f = fixture({
      historyOffset: 0,
      copyRegion: null,
      regions: [],
      resizeToken: null,
      splitLayout: null,
      paneActions: null,
      editorMessage: null,
      ...overrides,
    });
    assert.equal(f.publish().presenceRevision, 1);
  }
});
