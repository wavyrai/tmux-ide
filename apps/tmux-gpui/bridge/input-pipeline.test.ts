import { test } from "node:test";
import assert from "node:assert/strict";
import { createInputPipeline } from "./input-pipeline.ts";
import { deliverPreviewInput, isPipelineInput } from "./input.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("delayed acknowledgements admit eight ordered keys, never nine; drain waits for every acknowledgement", async () => {
  const acks = Array.from({ length: 12 }, deferred);
  const sent: number[] = [];
  const lane = createInputPipeline((error) => assert.fail(String(error)));
  let finished = false;
  const producer = (async () => {
    for (let index = 0; index < 12; index++) {
      await lane.submit(() => {
        sent.push(index);
        return acks[index]!.promise;
      });
    }
    await lane.barrier();
    finished = true;
  })();
  await turn();
  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(finished, false);
  // Out-of-order acknowledgements free slots without reordering dispatch.
  for (const index of [7, 2, 5, 0]) {
    acks[index]!.resolve();
    await turn();
    assert.equal(sent.length, 8 + [7, 2, 5, 0].indexOf(index) + 1);
  }
  assert.deepEqual(
    sent,
    Array.from({ length: 12 }, (_, index) => index),
  );
  acks.forEach((ack, index) => {
    if (index !== 1) ack.resolve();
  });
  await turn();
  assert.equal(finished, false);
  acks[1]!.resolve();
  await producer;
  assert.equal(finished, true);
});

test("first failure retires waiting admission without replay or later dispatch", async () => {
  const acks = Array.from({ length: 8 }, deferred);
  const failures: unknown[] = [];
  const lane = createInputPipeline((error) => failures.push(error));
  for (const ack of acks) await lane.submit(() => ack.promise);
  let extra = 0;
  const error = new Error("Ambiguous acknowledgement");
  const waiting = assert.rejects(
    lane.submit(async () => {
      extra++;
    }),
    (value) => value === error,
  );
  acks[3]!.reject(error);
  await waiting;
  acks[0]!.reject(new Error("Later failure"));
  acks.slice(1).forEach((ack) => ack.resolve());
  await turn();
  await assert.rejects(
    lane.submit(async () => {
      extra++;
    }),
    (value) => value === error,
  );
  await assert.rejects(lane.barrier(), (value) => value === error);
  assert.equal(extra, 0);
  assert.deepEqual(failures, [error]);
});

test(
  "retirement wakes full admission and drain even when transport never acknowledges",
  { timeout: 1000 },
  async () => {
    for (const drain of [false, true]) {
      const lane = createInputPipeline((error) => assert.fail(String(error)));
      for (let index = 0; index < 8; index++) await lane.submit(() => new Promise(() => {}));
      let extra = 0;
      const pending = assert.rejects(
        drain
          ? lane.barrier()
          : lane.submit(async () => {
              extra++;
            }),
        /retired/,
      );
      lane.retire();
      await pending;
      assert.equal(extra, 0);
    }
  },
);

test("paste and control barriers cannot interleave with prior or later keys", async () => {
  const lane = createInputPipeline((error) => assert.fail(String(error)));
  const first = deferred();
  const chunks = [deferred(), deferred(), deferred()];
  const sent: string[] = [];
  await lane.submit(() => {
    sent.push("key-before");
    return first.promise;
  });
  const producer = (async () => {
    await lane.barrier();
    let index = 0;
    await deliverPreviewInput(
      {
        ownsConnectionAuthority: () => true,
        sendTerminalInput: async (_target, input) => {
          sent.push(input.data);
          await chunks[index++]!.promise;
          return "ok";
        },
      },
      "workspace",
      "pane",
      { kind: "paste", data: "x".repeat(2048) },
      true,
    );
    await lane.submit(async () => {
      sent.push("key-after");
    });
    await lane.barrier();
    sent.push("control");
  })();
  await turn();
  assert.deepEqual(sent, ["key-before"]);
  first.resolve();
  for (const chunk of chunks) {
    await turn();
    assert.equal(sent.includes("key-after"), false);
    chunk.resolve();
  }
  await producer;
  assert.equal(sent.slice(1, 4).join(""), "\x1b[200~" + "x".repeat(2048) + "\x1b[201~");
  assert.deepEqual(sent.slice(4), ["key-after", "control"]);
});

test("authority is revalidated after a capacity wait before dispatch", async () => {
  const ack = deferred();
  let authority = true;
  let sends = 0;
  const errors: unknown[] = [];
  const checked = createInputPipeline((error) => errors.push(error));
  for (let index = 0; index < 8; index++) await checked.submit(() => ack.promise);
  const waiting = checked.submit(() =>
    deliverPreviewInput(
      {
        ownsConnectionAuthority: () => authority,
        sendTerminalInput: async () => {
          sends++;
          return "ok";
        },
      },
      "workspace",
      "pane",
      { kind: "text", data: "x" },
      false,
    ),
  );
  authority = false;
  ack.resolve();
  await waiting;
  await assert.rejects(checked.barrier(), /authority/);
  assert.equal(sends, 0);
  assert.equal(errors.length, 1);
});

test("only bounded printable text and unmodified navigation/edit keys pipeline", () => {
  for (const input of [
    { kind: "text", data: "界🙂" },
    { kind: "key", data: "Left" },
    { kind: "key", data: "BSpace" },
  ])
    assert.equal(isPipelineInput(input), true);
  for (const input of [
    { kind: "paste", data: "hello" },
    { kind: "text", data: "\n" },
    { kind: "key", data: "Enter" },
    { kind: "key", data: "C-c" },
    { kind: "bytes", data: "61" },
    { kind: "presence", active: false },
    { kind: "text", data: "x".repeat(1025) },
  ])
    assert.equal(isPipelineInput(input), false);
});

test("one waiting admission bounds capacity even for concurrent callers", async () => {
  const lane = createInputPipeline((error) => assert.fail(String(error)));
  const ack = deferred();
  let sent = 0;
  const send = () => {
    sent++;
    return ack.promise;
  };
  await Promise.all(Array.from({ length: 8 }, () => lane.submit(send)));
  const ninth = lane.submit(send);
  await assert.rejects(lane.submit(send), /Concurrent input admission/);
  assert.equal(sent, 8);
  ack.resolve();
  await ninth;
  await lane.barrier();
  assert.equal(sent, 9);
});

test("synchronous dispatch failure latches once, and retirement wins a capacity wake", async () => {
  const failures: unknown[] = [];
  const lane = createInputPipeline((error) => failures.push(error));
  const error = new Error("Synchronous dispatch failed");
  await assert.rejects(
    lane.submit(() => {
      throw error;
    }),
    (value) => value === error,
  );
  await assert.rejects(
    lane.submit(async () => assert.fail("must not dispatch")),
    (value) => value === error,
  );
  assert.deepEqual(failures, [error]);
  const waking = createInputPipeline((error) => assert.fail(String(error)));
  const ack = deferred();
  for (let i = 0; i < 8; i++) await waking.submit(() => ack.promise);
  const waiter = assert.rejects(
    waking.submit(async () => assert.fail("retirement must win")),
    /retired/,
  );
  ack.resolve();
  queueMicrotask(() => waking.retire());
  await waiter;
});
