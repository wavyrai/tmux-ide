import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLsofDescriptors,
  assertIsolationResourceBudget,
  countLinuxDescriptors,
  partialLsofOutput,
} from "./development-isolation-resources.mjs";
test("lsof counts only numeric descriptors and rejects foreign process rows", () => {
  assert.deepEqual(
    parseLsofDescriptors("p10\nfcwd\nftxt\nf0r\nf1w\nf1w\nf25u\np11\nf0\n", [10, 11]),
    { 10: 3, 11: 1 },
  );
  assert.throws(() => parseLsofDescriptors("p12\nf0\n", [10]), /Unowned/);
  assert.throws(() => parseLsofDescriptors("f0\n", [10]), /without process/);
  assert.throws(() => parseLsofDescriptors("p10\np10\n", [10]), /Duplicate/);
});
test("resource budgets enforce count, per-process, total and missing roots", () => {
  const base = { processes: [{ pid: 10 }], fdCounts: { 10: 20 }, missingRootPids: [] };
  assert.doesNotThrow(() => assertIsolationResourceBudget(base));
  assert.throws(
    () => assertIsolationResourceBudget({ ...base, processes: Array(41).fill({}) }),
    /process budget/,
  );
  assert.throws(
    () => assertIsolationResourceBudget({ ...base, fdCounts: { 10: 513 } }),
    /Per-process/,
  );
  assert.throws(
    () =>
      assertIsolationResourceBudget({
        ...base,
        fdCounts: { 10: 500, 11: 500, 12: 500, 13: 500, 14: 500 },
      }),
    /Total/,
  );
  assert.throws(
    () => assertIsolationResourceBudget({ ...base, missingRootPids: [10] }),
    /disappeared/,
  );
});

test("Linux vanished children are omitted, but missing owned roots fail closed", async () => {
  const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
  const read = async (path) => {
    if (path.includes("/11/")) throw missing;
    return ["0", "1", "x"];
  };
  assert.deepEqual(await countLinuxDescriptors([10, 11], [10], read), { 10: 2 });
  await assert.rejects(countLinuxDescriptors([10, 11], [10, 11], read), /root missing/);
});

test("only a clean lsof partial process result is eligible for strict root validation", () => {
  assert.equal(partialLsofOutput({ code: 1, stderr: "", stdout: "p10\nf0\n" }), "p10\nf0\n");
  for (const error of [
    { code: 2, stderr: "", stdout: "" },
    { code: 1, stderr: "permission denied", stdout: "p10" },
    { code: "ETIMEDOUT", stderr: "", stdout: "p10" },
  ])
    assert.throws(() => partialLsofOutput(error));
});
