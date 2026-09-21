import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import {
  contractsInitializerPurityPlugin,
  transformContractsInitializers,
} from "./contracts-initializer-purity.mjs";

const root = resolve("packages/contracts/src");

test("only wraps top-level initializers in the audited contracts directory", () => {
  const source = `export const schema = makeSchema();\nfunction parse() { const value = sideEffect(); return value; }`;
  const transformed = transformContractsInitializers(source, resolve(root, "example.ts"));
  assert.ok(transformed.includes("/*#__PURE__*/ (() => (makeSchema()))()"));
  assert.ok(transformed.includes("function parse() { const value = sideEffect(); return value; }"));
  for (const path of [
    "packages/daemon/src/example.ts",
    "packages/contracts/src/__tests__/example.ts",
    "packages/contracts/src/example.test.ts",
    "packages/contracts/src/example.d.ts",
  ]) {
    assert.equal(transformContractsInitializers(source, resolve(path)), source);
  }
});

test("refuses top-level await but preserves awaits inside function initializers", () => {
  assert.throws(
    () =>
      transformContractsInitializers(
        "export const value = await load();",
        resolve(root, "example.ts"),
      ),
    /asynchronous contract initializer/,
  );
  assert.ok(
    transformContractsInitializers(
      "export const load = async () => { return await fetch(); };",
      resolve(root, "example.ts"),
    ).includes("async () => { return await fetch(); }"),
  );
});

test("bundling drops unused construction and preserves used schema parsing and refinements", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "contracts-purity-"));
  try {
    const source = `import { z } from "zod";
export const unused = z.object({ expensive: z.string().default("UNUSED_EXPENSIVE_SCHEMA_MARKER") });
export const used = z.object({ value: z.number() }).strict().superRefine((value, ctx) => {
  if (value.value < 0) ctx.addIssue({ code: "custom", message: "negative values forbidden" });
});`;
    await writeFile(resolve(fixture, "schemas.ts"), source);
    const entry = `export { used } from ${JSON.stringify(resolve(fixture, "schemas.ts"))};`;
    const options = {
      stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      // Resolve the fixture's only third-party dependency from this repository.
      nodePaths: [resolve("node_modules")],
    };
    const before = (await build(options)).outputFiles[0].text;
    const after = (
      await build({ ...options, plugins: [contractsInitializerPurityPlugin({ root: fixture })] })
    ).outputFiles[0].text;
    assert.ok(before.includes("UNUSED_EXPENSIVE_SCHEMA_MARKER"));
    assert.ok(!after.includes("UNUSED_EXPENSIVE_SCHEMA_MARKER"));
    const { used } = await import(
      `data:text/javascript;base64,${Buffer.from(after).toString("base64")}`
    );
    assert.deepEqual(used.parse({ value: 2 }), { value: 2 });
    assert.equal(used.safeParse({ value: "2" }).success, false);
    assert.equal(used.safeParse({ value: 2, extra: true }).success, false);
    const invalid = used.safeParse({ value: -1 });
    assert.equal(invalid.success, false);
    assert.equal(invalid.error.issues[0].message, "negative values forbidden");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real daemon and stream bundles preserve validation and public schema identity", async () => {
  const entry = `
export {
  DaemonInstanceIdentitySchemaZ,
  CanonicalDaemonInfoSchema,
  PaneStreamLeaseRequestSchemaZ,
  PaneStreamLoopbackWebSocketUrlSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonCapabilityErrorSchemaZ,
} from "./packages/contracts/src/index.ts";
export { DesktopDaemonCapabilityErrorSchemaZ as leafError } from "./packages/contracts/src/desktop-daemon-capability-error.ts";
export { DesktopDaemonCapabilityErrorSchemaZ as legacyError } from "./packages/contracts/src/desktop-host.ts";
export { PaneStreamLeaseRequestSchemaZ as leafLease } from "./packages/contracts/src/pane-stream.ts";
`;
  const options = {
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  };
  const modules = [];
  for (const plugins of [[], [contractsInitializerPurityPlugin()]]) {
    const result = await build({ ...options, plugins });
    modules.push(
      await import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      ),
    );
  }
  const identity = {
    protocolVersion: 2,
    productVersion: " 2.9.0-beta.11 ",
    instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
    startedAt: "2026-07-20T12:34:56.123Z",
  };
  const canonical = {
    ...identity,
    pid: 4312,
    port: 4010,
    bindHostname: "127.0.0.1",
    authToken: "fixture-token",
  };
  const lease = {
    protocolVersion: 1,
    workspaceName: "workspace.alpha",
    panes: ["pane.editor"],
    viewerMode: "read-only",
  };
  const cases = [
    ["DaemonInstanceIdentitySchemaZ", identity, true],
    ["DaemonInstanceIdentitySchemaZ", { ...identity, protocolVersion: 99 }, true],
    ["DaemonInstanceIdentitySchemaZ", { ...identity, instanceId: "invalid" }, false],
    ["DaemonInstanceIdentitySchemaZ", { ...identity, environmentId: "invalid" }, false],
    ["DaemonInstanceIdentitySchemaZ", { ...identity, unexpected: true }, false],
    ["CanonicalDaemonInfoSchema", canonical, true],
    ["CanonicalDaemonInfoSchema", { ...canonical, port: 65536 }, false],
    ["PaneStreamLeaseRequestSchemaZ", lease, true],
    ["PaneStreamLeaseRequestSchemaZ", { ...lease, panes: ["pane.editor", "pane.editor"] }, false],
    ["PaneStreamLeaseRequestSchemaZ", { ...lease, panes: ["%5"] }, false],
    ["PaneStreamLeaseRequestSchemaZ", { ...lease, viewport: { cols: 80, rows: 24 } }, false],
    [
      "PaneStreamLoopbackWebSocketUrlSchemaZ",
      "ws://127.0.0.1:6070/v1/terminal/pane-streams/redeem",
      true,
    ],
    [
      "PaneStreamLoopbackWebSocketUrlSchemaZ",
      "ws://example.com:6070/v1/terminal/pane-streams/redeem",
      false,
    ],
    [
      "PaneStreamLoopbackWebSocketUrlSchemaZ",
      "ws://user:pass@127.0.0.1:6070/v1/terminal/pane-streams/redeem",
      false,
    ],
    ["DesktopDaemonEventSubscriptionRequestSchemaZ", { workspaceNames: ["workspace.alpha"] }, true],
    [
      "DesktopDaemonEventSubscriptionRequestSchemaZ",
      { workspaceNames: ["workspace.alpha", "workspace.alpha"] },
      false,
    ],
    ["DesktopDaemonCapabilityErrorSchemaZ", { code: "disposed", reason: "closed" }, true],
    ["DesktopDaemonCapabilityErrorSchemaZ", { code: "disposed", reason: "x".repeat(241) }, false],
  ];
  for (const [name, input, expectedSuccess] of cases) {
    const outcomes = modules.map((module) => {
      const result = module[name].safeParse(input);
      assert.equal(result.success, expectedSuccess, `${name}: ${JSON.stringify(input)}`);
      return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: result.error.issues };
    });
    assert.deepEqual(outcomes[1], outcomes[0], `${name} changed after purity annotation`);
  }
  for (const module of modules) {
    assert.equal(module.DesktopDaemonCapabilityErrorSchemaZ, module.leafError);
    assert.equal(module.DesktopDaemonCapabilityErrorSchemaZ, module.legacyError);
    assert.equal(module.PaneStreamLeaseRequestSchemaZ, module.leafLease);
    assert.equal(
      module.DaemonInstanceIdentitySchemaZ.parse(identity).productVersion,
      "2.9.0-beta.11",
    );
  }
});
