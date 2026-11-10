import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { createPaneReaderResolver, PaneReaderUnavailable } from "./tmux-pane-reader.ts";
import { analyzeTrustedSemanticPaneCatalog } from "../terminal/attachments/semantic-pane-catalog.ts";
import type { NativeTerminalInventoryPaneSnapshot } from "../terminal/attachments/native-runtime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const generation = "12345678-1234-4234-8234-123456789012";
const target = {
  generation,
  workspaceName: "checkout",
  liveSessionId: "live-session.01234567890123456789",
  semanticPaneId: "pane-main",
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pane-reader-resolver-")));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, ".git"));
  const md = join(root, "docs", "release-notes.md");
  writeFileSync(md, "# Release notes\n");
  writeFileSync(join(root, "docs", "a.png"), "png");
  const registry = new WorkspaceRegistry({ dir: root, listSessions: () => [] });
  registry.add({ name: "checkout", sessionName: "work", projectDir: root });
  const pane: NativeTerminalInventoryPaneSnapshot = {
    workspaceName: "checkout",
    sessionName: "work",
    sessionId: "$1",
    windowId: "@1",
    runtimePaneId: "%1",
    semanticPaneId: "pane-main",
    windowStamp: "window-main",
    windowPaneCount: 1,
    sessionWindowCount: 1,
    index: 0,
    title: "pane",
    currentCommand: "node",
    active: true,
    role: null,
    name: null,
    type: null,
    missionStamp: null,
    dir: root,
    nativePaneBirthId: "1",
  };
  const state = {
    option: JSON.stringify({ version: 1, pid: 4242, path: md }) as string,
    birth: "1",
    alive: true,
    afterFirst: null as null | (() => void),
  };
  let observed = 0;
  const run = vi.fn(async (args: readonly string[], signal: AbortSignal) => {
    signal.throwIfAborted();
    expect(args.slice(0, 4)).toEqual(["display-message", "-p", "-t", "%1"]);
    const reply = `pane-main\t${state.birth}\t${state.option}\n`;
    if (++observed === 1) state.afterFirst?.();
    return reply;
  });
  const resolver = createPaneReaderResolver({
    generation,
    registry,
    catalog: async () => [
      { liveSessionId: target.liveSessionId, sessionName: "work", paneCount: 1 },
    ],
    inventory: {
      discoverTerminalInventory: async () => ({
        panes: [{ ...pane }],
        catalog: analyzeTrustedSemanticPaneCatalog([
          {
            workspaceName: pane.workspaceName,
            semanticPaneId: pane.semanticPaneId,
            sessionId: pane.sessionId,
            windowId: pane.windowId,
            runtimePaneId: pane.runtimePaneId,
            windowStamp: pane.windowStamp,
            windowPaneCount: 1,
            sessionWindowCount: 1,
          },
        ]),
      }),
    },
    run,
    assertOpen: () => undefined,
    alive: (pid) => state.alive && pid === 4242,
  });
  return { root, md, state, resolver, run };
}
const signal = () => AbortSignal.timeout(2000);

it("serves the live reader's file with its name and folder, never its path", async () => {
  const f = fixture();
  const response = await f.resolver.read({ target, have: null, page: null }, signal());
  expect(response).toMatchObject({
    version: 1,
    state: "ok",
    name: "release-notes.md",
    folder: "docs",
    offset: 0,
  });
  if (response.state !== "ok") throw new Error();
  expect(Buffer.from(response.chunk, "base64").toString()).toBe("# Release notes\n");
  expect(JSON.stringify(response)).not.toContain(f.root);
  expect(
    await f.resolver.read({ target, have: response.revision, page: null }, signal()),
  ).toMatchObject({ state: "unchanged" });
  expect(f.run).toHaveBeenCalledTimes(4);
});
it("refuses a dead reader process, a reused pane and a non-Markdown option", async () => {
  for (const change of [
    (s: ReturnType<typeof fixture>["state"]) => (s.alive = false),
    (s: ReturnType<typeof fixture>["state"]) => (s.birth = "2"),
    (s: ReturnType<typeof fixture>["state"]) => (s.option = ""),
    (s: ReturnType<typeof fixture>["state"]) =>
      (s.option = JSON.stringify({ version: 1, pid: 4242, path: "/etc/passwd" })),
  ]) {
    const f = fixture();
    change(f.state);
    await expect(
      f.resolver.read({ target, have: null, page: null }, signal()),
    ).rejects.toBeInstanceOf(PaneReaderUnavailable);
    await expect(
      f.resolver.asset({ target, src: "a.png", page: null }, signal()),
    ).rejects.toBeInstanceOf(PaneReaderUnavailable);
  }
});
it("refuses when the pane is replaced during the read", async () => {
  const f = fixture();
  f.state.afterFirst = () => (f.state.birth = "9");
  await expect(f.resolver.read({ target, have: null, page: null }, signal())).rejects.toThrow(
    PaneReaderUnavailable,
  );
});
it("refuses stale targets and unknown fields before reading tmux", async () => {
  const f = fixture();
  await expect(
    f.resolver.read(
      {
        target: { ...target, generation: "32345678-1234-4234-8234-123456789012" },
        have: null,
        page: null,
      },
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    f.resolver.read({ target, have: null, page: null, path: "/etc/passwd" }, signal()),
  ).rejects.toThrow();
  await expect(
    f.resolver.asset(
      { target: { ...target, semanticPaneId: "pane-other" }, src: "a.png", page: null },
      signal(),
    ),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("serves images through the same pane proof", async () => {
  const f = fixture();
  expect(await f.resolver.asset({ target, src: "a.png", page: null }, signal())).toMatchObject({
    version: 1,
    state: "ok",
    mime: "image/png",
  });
  expect(
    await f.resolver.asset({ target, src: "https://example.com/a.png", page: null }, signal()),
  ).toEqual({ version: 1, state: "refused" });
});
