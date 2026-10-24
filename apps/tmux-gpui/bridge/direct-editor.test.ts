import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectEditor, type EditorBinding, type EditorResult } from "./direct-editor.ts";
const generation = "12345678-1234-4234-8234-123456789abc";
const id = "22345678-1234-4234-8234-123456789abc";
const operationId = "32345678-1234-4234-8234-123456789abc";
const command = {
  type: "native-editor-open",
  version: 1,
  id,
  request: 3,
  sequence: 1,
  operationId,
  presenceRevision: 4,
  pane: "pane.one",
  generation,
  incarnation: "one",
};
function fixture() {
  const response = {
    version: 1 as const,
    server: { serverId: `tmux-server.${"a".repeat(32)}`, generation },
    context: {
      generation,
      workspaceName: "workspace",
      liveSessionId: `live-session.${"b".repeat(20)}`,
      semanticPaneId: "pane.one",
      cwd: { kind: "absolute" as const, path: "/private/folder" },
      directory: "/private/folder",
    },
  };
  let current = true;
  const binding: EditorBinding = {
    id,
    request: 3,
    origin: "tmux-ide://app",
    hostClientId: "native.fixture",
    config: {
      baseUrl: "http://127.0.0.1:4000",
      ownerToken: "private-owner-secret",
      scope: response.server,
      workspaceName: "workspace",
      liveSessionId: response.context.liveSessionId,
      semanticPaneId: "pane.one",
    },
    proof: { assertCurrent() {}, async verify() {} },
    current: (r) => current && r === 4,
    read: async () => response,
  };
  return {
    response,
    binding,
    revoke: () => {
      current = false;
    },
  };
}
test("native read uses exact owner context once and publishes no directory or credentials", async () => {
  const f = fixture(),
    sent: EditorResult[] = [];
  let calls = 0;
  const broker = createDirectEditor(
    (v) => sent.push(v),
    async (options) => {
      calls++;
      assert.ok(options.current());
      assert.equal(
        (await options.read(new AbortController().signal)).context.directory,
        "/private/folder",
      );
      return "Folder open request sent to VS Code";
    },
  );
  broker.bind(f.binding);
  await broker.handle(command);
  await broker.handle(command);
  assert.equal(calls, 1);
  assert.equal(sent[0]?.status, "opened");
  assert.ok(!JSON.stringify(sent).includes("private"));
});
test("wrong scope, presence, catalog mode, malformed fields and old sequence never launch", async () => {
  for (const changed of [
    { pane: "pane.other" },
    { request: 2 },
    { generation: id },
    { id: operationId },
    { presenceRevision: 3 },
    { sequence: 0 },
    { ownerToken: "secret" },
  ]) {
    const f = fixture();
    let calls = 0;
    const broker = createDirectEditor(
      () => {},
      async () => {
        calls++;
        return "";
      },
    );
    broker.bind(f.binding);
    await broker.handle({ ...command, ...changed });
    assert.equal(calls, 0);
  }
  const f = fixture();
  let calls = 0;
  const broker = createDirectEditor(
    () => {},
    async () => {
      calls++;
      return "";
    },
  );
  broker.bind({ ...f.binding, catalogOnly: true });
  await broker.handle(command);
  assert.equal(calls, 0);
});
test("retirement, cancellation or focus loss during read suppress launch eligibility and result", async () => {
  for (const reason of ["retire", "cancel", "focus"]) {
    const f = fixture(),
      sent: EditorResult[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stillCurrent = true;
    const broker = createDirectEditor(
      (v) => sent.push(v),
      async (options) => {
        await wait;
        stillCurrent = options.current();
        return "Folder open request sent to VS Code";
      },
    );
    broker.bind(f.binding);
    const pending = broker.handle(command);
    if (reason === "retire") broker.retire();
    else if (reason === "focus") f.revoke();
    else
      await broker.handle({
        type: "native-editor-cancel",
        version: 1,
        id,
        request: 3,
        operationId,
      });
    release();
    await pending;
    assert.equal(stillCurrent, false);
    assert.deepEqual(sent, []);
  }
});
test("mismatched owner response cannot become an editor launch context", async () => {
  const f = fixture(),
    sent: EditorResult[] = [];
  f.response.context.semanticPaneId = "pane.other";
  const broker = createDirectEditor(
    (v) => sent.push(v),
    async (options) => {
      await options.read(new AbortController().signal);
      throw new Error("should reject earlier");
    },
  );
  broker.bind(f.binding);
  await broker.handle(command);
  assert.equal(sent[0]?.status, "failed");
});
test("single in-flight read returns bounded busy and consumes duplicate operations", async () => {
  const f = fixture(),
    sent: EditorResult[] = [];
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const broker = createDirectEditor(
    (v) => sent.push(v),
    async () => {
      calls++;
      await wait;
      return "Folder open request sent to VS Code";
    },
  );
  broker.bind(f.binding);
  const first = broker.handle(command);
  await broker.handle({ ...command, operationId: id, sequence: 2 });
  release();
  await first;
  await broker.handle({ ...command, operationId: id, sequence: 3 });
  assert.equal(calls, 1);
  assert.deepEqual(
    sent.map((x) => x.status),
    ["busy", "opened"],
  );
});
