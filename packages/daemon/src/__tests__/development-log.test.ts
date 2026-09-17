import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createBoundedDevelopmentLog } from "../lib/development-log.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dev-log-"));
  roots.push(root);
  return join(root, "owner.log");
}
it("bounds queued and in-flight bytes under a blocked disk writer without blocking producer", async () => {
  const path = fixture();
  let release!: (n: number) => void;
  const log = createBoundedDevelopmentLog(path, {
    queueBytes: 64,
    limitBytes: 128,
    write: (_fd, data) =>
      new Promise((resolve) => {
        release = () => resolve(data.length);
      }),
  });
  log.write("x".repeat(64));
  for (let n = 0; n < 1000; n++) log.write("y".repeat(64));
  expect(log.snapshot()).toMatchObject({
    queuedBytes: 64,
    queuedEntries: 1,
    droppedBytes: 64000,
    failed: false,
  });
  release(64);
  await log.close();
});
it("keeps the on-disk log bounded and handles disk failures without recursive output", async () => {
  const path = fixture();
  const log = createBoundedDevelopmentLog(path, { limitBytes: 64 });
  for (let n = 0; n < 5; n++) {
    log.write("x".repeat(60));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await log.close();
  expect(statSync(path).size).toBeLessThanOrEqual(64);
  const failing = createBoundedDevelopmentLog(fixture(), {
    write: async () => {
      throw new Error("disk full");
    },
  });
  failing.write("hello");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(failing.snapshot()).toMatchObject({ failed: true, queuedBytes: 0 });
  expect(() => failing.write("later")).not.toThrow();
  await failing.close();
});
it("refuses redirected logs before writing", () => {
  const path = fixture();
  const target = `${path}.target`;
  writeFileSync(target, "sentinel");
  symlinkSync(target, path);
  expect(() => createBoundedDevelopmentLog(path)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("sentinel");
});
