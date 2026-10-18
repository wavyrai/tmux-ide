import assert from "node:assert/strict";
import { test } from "node:test";
import { hostSchema } from "./config.ts";
import { registerVerifiedVersion } from "./diagnostic-versions.ts";
import { createServerDiagnosticVersion } from "./server-diagnostic-version.ts";
import type { readTmuxServerDiagnostics } from "../../../packages/daemon-client/src/tmux-server-client.ts";

function fixture() {
  const host = hostSchema.parse({
    baseUrl: "http://127.0.0.1:1234",
    ownerToken: "private",
    scope: {
      serverId: "tmux-server." + "a".repeat(32),
      generation: "00000000-0000-4000-8000-000000000001",
    },
  });
  let current = true;
  registerVerifiedVersion(host, null, () => {
    if (!current) throw new Error("retired");
  });
  let resolve!: (value: Awaited<ReturnType<typeof readTmuxServerDiagnostics>>) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<typeof readTmuxServerDiagnostics>>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let calls = 0;
  let signal: AbortSignal | undefined;
  const read: typeof readTmuxServerDiagnostics = (options, scope, abort) => {
    calls++;
    signal = abort;
    assert.equal(options.timeoutMs, 2500);
    assert.deepEqual(scope, host.scope);
    return pending;
  };
  return {
    host,
    read,
    resolve,
    reject,
    retire: () => {
      current = false;
    },
    calls: () => calls,
    signal: () => signal,
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
test("optional probe returns immediately, runs once, and notifies newest request only", async () => {
  const f = fixture(),
    owner = createServerDiagnosticVersion(f.host, f.read);
  let old = 0,
    latest = 0;
  assert.equal(
    owner.get(() => old++),
    null,
  );
  assert.equal(
    owner.get(() => latest++),
    null,
  );
  assert.equal(f.calls(), 1);
  f.resolve({ version: 1, server: f.host.scope, tmuxVersion: "3.8" });
  await settle();
  assert.equal(old, 0);
  assert.equal(latest, 1);
  assert.equal(
    owner.get(() => {}),
    "3.8",
  );
  assert.equal(f.calls(), 1);
  owner.dispose();
  assert.equal(
    owner.get(() => {}),
    null,
  );
});
test("unverified parsed clone cannot probe", () => {
  const f = fixture(),
    owner = createServerDiagnosticVersion({ ...f.host }, f.read);
  assert.equal(
    owner.get(() => assert.fail()),
    null,
  );
  assert.equal(f.calls(), 0);
  owner.dispose();
});
for (const retire of ["dispose", "proof"] as const)
  test(`late completion after ${retire} cannot publish`, async () => {
    const f = fixture(),
      owner = createServerDiagnosticVersion(f.host, f.read);
    owner.get(() => assert.fail("retired owner published"));
    if (retire === "dispose") {
      owner.dispose();
      assert.equal(f.signal()?.aborted, true);
    } else f.retire();
    f.resolve({ version: 1, server: f.host.scope, tmuxVersion: "3.8" });
    await settle();
    assert.equal(
      owner.get(() => assert.fail()),
      null,
    );
    owner.dispose();
  });
for (const outcome of ["404", "error"] as const)
  test(`optional ${outcome} remains unknown without retry`, async () => {
    const f = fixture(),
      owner = createServerDiagnosticVersion(f.host, f.read);
    owner.get(() => {});
    if (outcome === "404") f.resolve(null);
    else f.reject(new Error("private detail"));
    await settle();
    assert.equal(
      owner.get(() => {}),
      null,
    );
    assert.equal(f.calls(), 1);
    owner.dispose();
  });
