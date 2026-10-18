import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerVerifiedVersion,
  verifiedVersion,
  safeProductVersion,
} from "./diagnostic-versions.ts";
import { hostSchema } from "./config.ts";
import { createPreviewCatalog } from "./catalog.ts";

test("only verified exact owner metadata survives until retirement", () => {
  const host = hostSchema.parse({
    baseUrl: "http://127.0.0.1:1234",
    ownerToken: "private",
    scope: {
      serverId: "tmux-server." + "a".repeat(32),
      generation: "00000000-0000-4000-8000-000000000001",
    },
  });
  assert.equal(verifiedVersion(host), null);
  let current = true;
  registerVerifiedVersion(host, "2.9.7", () => {
    if (!current) throw new Error("retired");
  });
  assert.equal(verifiedVersion({ ...host }), null);
  const catalog = createPreviewCatalog(host);
  assert.equal(catalog.diagnosticVersion(), "2.9.7");
  current = false;
  assert.equal(catalog.diagnosticVersion(), null);
  current = true;
  catalog.dispose();
  assert.equal(catalog.diagnosticVersion(), null);
});
test("version metadata rejects freeform secrets and remains bounded", () => {
  for (const value of [
    "token=secret",
    "/private/path",
    "2.9.7\nsecret",
    "2.9.7" + "a".repeat(64),
    "",
    "2.9",
  ])
    assert.equal(safeProductVersion(value), null);
  for (const value of ["2.9.7", "2.9.7-beta.1+build.2"])
    assert.equal(safeProductVersion(value), value);
});
