import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverInput } from "./input.ts";
test("input requires authority before sending and does not request it implicitly", async () => {
  let sends = 0;
  await assert.rejects(
    deliverInput(
      {
        ownsConnectionAuthority: () => false,
        sendTerminalInput: async () => {
          sends++;
          return "ok";
        },
      },
      "workspace",
      "pane-a",
      { kind: "text", data: "a" },
    ),
  );
  assert.equal(sends, 0);
});
test("pins exact pane and never retries an ambiguous acknowledgement", async () => {
  let sends = 0;
  await assert.rejects(
    deliverInput(
      {
        ownsConnectionAuthority: () => true,
        sendTerminalInput: async (target, input) => {
          sends++;
          assert.deepEqual(target, { workspaceName: "workspace", semanticPaneId: "pane-a" });
          assert.deepEqual(input, { kind: "key", data: "Enter" });
          throw new Error("Disconnected after possible acceptance");
        },
      },
      "workspace",
      "pane-a",
      { kind: "key", data: "Enter" },
    ),
  );
  assert.equal(sends, 1);
});

test("paste wraps once, preserves Unicode across chunks, and stays on its pane", async () => {
  const { deliverPreviewInput } = await import("./input.ts");
  for (const bracketed of [false, true]) {
    const sent: string[] = [];
    const text = "a".repeat(1017) + "🌍\n界".repeat(400);
    await deliverPreviewInput(
      {
        ownsConnectionAuthority: () => true,
        sendTerminalInput: async (target, input) => {
          assert.deepEqual(target, { workspaceName: "w", semanticPaneId: "p" });
          assert.equal(input.kind, "text");
          assert.ok(input.data.length <= 1024);
          assert.equal(Buffer.from(input.data).toString("utf8"), input.data);
          sent.push(input.data);
          return "ok";
        },
      },
      "w",
      "p",
      { kind: "paste", data: text },
      bracketed,
    );
    assert.equal(sent.join(""), bracketed ? "\u001b[200~" + text + "\u001b[201~" : text);
  }
});

test("paste stops on authority loss and rejects invalid clipboard content before sending", async () => {
  const { deliverPreviewInput } = await import("./input.ts");
  let sends = 0;
  const runtime = {
    ownsConnectionAuthority: () => sends === 0,
    sendTerminalInput: async () => {
      sends++;
      return "ok" as const;
    },
  };
  for (const text of ["x".repeat(65537), "\0", "\u001b[201~", ""]) {
    await assert.rejects(
      deliverPreviewInput(runtime, "w", "p", { kind: "paste", data: text }, true),
    );
  }
  assert.equal(sends, 0);
  await assert.rejects(
    deliverPreviewInput(runtime, "w", "p", { kind: "paste", data: "x".repeat(2048) }, true),
  );
  assert.equal(sends, 1);
});
