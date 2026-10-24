import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectNativePreview } from "./direct-native-preview.ts";
const context = { request: 4, foreground: true, workspace: true, liveAvailable: false };
const key = "private-host-session-key";
const proof = JSON.stringify([[key, "private-endpoint-instance", 12], { background: 123 }]);
test("opaque scopes preserve exact legacy equality without publishing route identity", () => {
  let current: string | null = proof;
  const previews = createDirectNativePreview(() => current);
  const a = previews.scope(key)!;
  assert.deepEqual(previews.scope(key), a);
  assert.match(a.key, /^[a-f0-9]{64}$/);
  assert.match(a.proof, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(a).includes("private"));
  current = `${proof} `;
  assert.notEqual(previews.scope(key)!.proof, a.proof);
  current = null;
  assert.equal(previews.scope(key), null);
});
test("preview intent expires at five seconds and continuation does not extend it", () => {
  let now = 100;
  const previews = createDirectNativePreview(
    () => proof,
    () => now,
  );
  previews.begin(key, 4);
  assert.ok(previews.publication(context));
  previews.continue(key, 5);
  now = 5099;
  assert.ok(previews.publication({ ...context, request: 5 }));
  now = 5100;
  assert.equal(previews.publication({ ...context, request: 5 }), null);
  now = 5101;
  assert.equal(previews.publication({ ...context, request: 5 }), null);
});
test("route/theme changes, navigation, background and live frames permanently clear intent", () => {
  for (const change of ["proof", "request", "foreground", "workspace", "live"] as const) {
    let current = proof;
    const previews = createDirectNativePreview(
      () => current,
      () => 0,
    );
    previews.begin(key, 4);
    if (change === "proof") current += "changed";
    const updated = {
      ...context,
      request: change === "request" ? 5 : 4,
      foreground: change !== "foreground",
      workspace: change !== "workspace",
      liveAvailable: change === "live",
    };
    assert.equal(previews.publication(updated), null);
    current = proof;
    assert.equal(previews.publication(context), null);
  }
});
test("invalid or absent proof and oversized keys cannot authorize a preview", () => {
  const previews = createDirectNativePreview(() => proof);
  assert.equal(previews.scope(""), null);
  assert.equal(previews.scope("x".repeat(16385)), null);
  previews.begin(key, Number.MAX_SAFE_INTEGER + 1);
  assert.equal(previews.publication(context), null);
});
