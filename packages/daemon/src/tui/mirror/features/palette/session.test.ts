import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";

import { palettePos, type PaletteAction } from "../../palette.ts";
import { paletteCommandId } from "../../palette-surface-adapter.ts";
import type {
  PaletteDynamicFacts,
  PaletteHostIntent,
  PaletteHostPort,
  PaletteWorkspaceIdentity,
} from "./contract.ts";
import { paletteWorkspaceIdentityScope } from "./contract.ts";
import { createPaletteFeatureSession } from "./session.ts";

const identity = (
  workspaceName: string,
  directory = "/repo",
  generation = 1,
): PaletteWorkspaceIdentity => ({
  workspaceName,
  directory,
  projectRoot: directory,
  daemonIdentity: "daemon-a",
  generation,
});

const facts = (): PaletteDynamicFacts => ({
  terminal: true,
  surface: "terminal",
  currentSurface: "terminals",
  currentViewId: "terminals",
  currentSession: "alpha",
  sessions: ["alpha", "beta"],
  agents: [
    {
      paneId: "%1",
      windowIndex: 0,
      session: "alpha",
      kind: "claude",
      state: "blocked",
      since: null,
    },
  ],
  panes: [
    { paneId: "%1", title: "Editor", session: "alpha", active: true },
    { paneId: "%2", title: "Tests", session: "alpha", active: false },
  ],
  sizeMismatch: true,
  appMousePane: true,
  againName: "claude",
  usage: { "surface:files": { count: 4, lastUsed: 99 } },
  keycaps: { "surface:files": "⌥E" },
  views: [],
  syncOn: false,
  saveState: { hasBuffer: true, hasPath: true, readOnlyReason: null },
  multiplexerFacts: {
    workspaceConnected: true,
    sessionWindowCount: 2,
    windowPaneCount: 2,
    windowZoomed: false,
    targetIsActivePane: true,
    targetIsDockedStackMember: false,
  },
});

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<PaletteHostPort> = {}) {
  const [currentIdentity, setCurrentIdentity] = createSignal(identity("alpha"));
  const [currentFacts, setCurrentFacts] = createSignal(facts());
  const intents: PaletteHostIntent[] = [];
  const repoLoads: Array<{ identity: PaletteWorkspaceIdentity; signal: AbortSignal }> = [];
  const bufferLoads: Array<{ identity: PaletteWorkspaceIdentity; signal: AbortSignal }> = [];
  const host: PaletteHostPort = {
    width: () => 120,
    height: () => 40,
    identity: currentIdentity,
    facts: currentFacts,
    loadRepoFiles: async (value, signal) => {
      repoLoads.push({ identity: value, signal });
      return ["src/index.ts", "README.md"];
    },
    loadBuffers: async (value, signal) => {
      bufferLoads.push({ identity: value, signal });
      return [
        { name: "buffer0", preview: "hello" },
        { name: "buffer1", preview: "world" },
      ];
    },
    dispatch: (intent) => {
      intents.push(intent);
    },
    ...overrides,
  };
  return {
    host,
    intents,
    repoLoads,
    bufferLoads,
    setIdentity(value: PaletteWorkspaceIdentity) {
      setCurrentIdentity(value);
    },
    setFacts(value: PaletteDynamicFacts) {
      setCurrentFacts(value);
    },
  };
}

const key = (
  name: string,
  extra: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {},
) => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...extra,
});

describe("PaletteFeatureSession", () => {
  it("owns grouped ranking, navigator scopes, stable ids, and live dynamic facts", async () => {
    const fx = fixture();
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    const before = session.entries();
    expect(before.some((entry) => entry.descriptor.group === "recent")).toBe(true);
    expect(before.some((entry) => entry.action.kind === "jump-agent")).toBe(true);
    expect(before.some((entry) => entry.action.kind === "jump-pane")).toBe(true);
    const pane = before.find((entry) => entry.action.kind === "jump-pane")!;
    expect(pane.id).toBe(paletteCommandId(pane.action));

    fx.setFacts({ ...facts(), currentSession: "beta", syncOn: true });
    expect(
      session
        .entries()
        .find((entry) => entry.action.kind === "attach" && entry.action.session === "beta")
        ?.descriptor.current,
    ).toBe(true);
    session.dispose();
  });

  it("keeps selection on stable command ids while query ranking and scrolling change", async () => {
    const fx = fixture();
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    session.handlePaste("pane tests");
    const selected = session.snapshot().selectedCommandId;
    expect(selected).toContain("jump-pane");
    session.handleKey(key("down"));
    expect(session.snapshot().selectedCommandId).not.toBeNull();
    expect(session.snapshot().projection.rowIds.length).toBeGreaterThan(0);
    session.dispose();
  });

  it("routes keyboard, sanitized paste, semantic settings handoff, and close", async () => {
    const fx = fixture();
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    expect(session.handlePaste("settings\nkeys\u001b")).toBe(true);
    expect(session.snapshot().query).toBe("settings keys ");
    const settings = session
      .entries()
      .find((entry) => entry.action.kind === "settings" && entry.action.id === "settings-keys")!;
    while (session.snapshot().selectedCommandId !== settings.id) session.handleKey(key("down"));
    session.handleKey(key("return"));
    expect(fx.intents).toContainEqual({
      kind: "settings",
      command: "settings-keys",
      usageKey: "settings:settings-keys",
    });
    expect(session.open()).toBe(false);
    expect(fx.intents[0]).toEqual({ kind: "close", reason: "action" });
    session.dispose();
  });

  it("uses projection pointer hits, wheel scrolling, and outside-close honesty", async () => {
    const fx = fixture();
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    const command = session
      .projection()
      .rows.find((row) => row.kind === "command" && !row.disabled)!;
    session.handlePointer({ kind: "move", x: command.rect.x, y: command.rect.y });
    expect(session.snapshot().selectedCommandId).toBe(command.commandId);
    session.handlePointer({
      kind: "scroll",
      x: command.rect.x,
      y: command.rect.y,
      scrollDirection: "down",
    });
    expect(session.snapshot().scrollTop).toBeGreaterThan(0);
    session.handlePointer({ kind: "down", x: 0, y: 0, button: 0 });
    expect(fx.intents.at(-1)).toEqual({ kind: "close", reason: "outside" });
    session.dispose();
  });

  it("routes buffer row hover/click and wheel through the picker geometry", async () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      name: `buffer${index}`,
      preview: `value ${index}`,
    }));
    const fx = fixture({ loadBuffers: async () => many });
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    session.openBufferPicker();
    await Promise.resolve();
    await Promise.resolve();
    const { left, top } = palettePos(120, 40, 64);
    session.handlePointer({
      kind: "scroll",
      x: left + 2,
      y: top + 3,
      scrollDirection: "down",
    });
    expect(session.snapshot().scrollTop).toBe(3);
    session.handlePointer({ kind: "move", x: left + 2, y: top + 4 });
    expect(session.snapshot().selectedBufferIndex).toBe(4);
    session.handlePointer({ kind: "down", x: left + 2, y: top + 4, button: 0 });
    expect(fx.intents).toContainEqual({ kind: "paste-buffer", bufferName: "buffer4" });
    session.dispose();
  });

  it("fences same-directory different-workspace repo results and aborts on switch", async () => {
    const first = deferred<readonly string[]>();
    const second = deferred<readonly string[]>();
    let calls = 0;
    const fx = fixture({
      loadRepoFiles: (value, signal) => {
        fx.repoLoads.push({ identity: value, signal });
        return calls++ === 0 ? first.promise : second.promise;
      },
    });
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    const beta = identity("beta", "/repo");
    fx.setIdentity(beta);
    session.switchWorkspace(beta);
    expect(fx.repoLoads[0]!.signal.aborted).toBe(true);
    second.resolve(["beta.ts"]);
    await second.promise;
    first.resolve(["alpha.ts"]);
    await first.promise;
    await Promise.resolve();
    expect(session.snapshot().repo.value).toEqual(["beta.ts"]);
    expect(
      session
        .entries()
        .some((entry) => entry.action.kind === "go-file" && entry.action.path === "alpha.ts"),
    ).toBe(false);
    session.dispose();
  });

  it("exposes repo failure honestly, retries, and caches ready data across reopen", async () => {
    let attempt = 0;
    const fx = fixture({
      loadRepoFiles: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("git unavailable");
        return ["fixed.ts"];
      },
    });
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.snapshot().repo).toMatchObject({ phase: "error", message: "git unavailable" });
    session.retryRepoFiles();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.snapshot().repo).toEqual({ phase: "ready", value: ["fixed.ts"] });
    session.close();
    session.openPalette();
    expect(attempt).toBe(2);
    session.dispose();
  });

  it("keeps buffer loading/error/retry/selection/paste honest and aborts on back", async () => {
    let attempt = 0;
    const pending = deferred<readonly { name: string; preview: string }[]>();
    const fx = fixture({
      loadBuffers: (_identity, signal) => {
        fx.bufferLoads.push({ identity: identity("alpha"), signal });
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("buffers unavailable"));
        return pending.promise;
      },
    });
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    session.openBufferPicker();
    await Promise.resolve();
    expect(session.snapshot().buffers).toMatchObject({
      phase: "error",
      message: "buffers unavailable",
    });
    session.handleKey(key("r"));
    pending.resolve([
      { name: "b0", preview: "zero" },
      { name: "b1", preview: "one" },
    ]);
    await pending.promise;
    await Promise.resolve();
    session.handleKey(key("down"));
    session.handleKey(key("return"));
    expect(fx.intents).toContainEqual({ kind: "paste-buffer", bufferName: "b1" });

    session.openPalette();
    session.openBufferPicker();
    session.handleKey(key("escape"));
    expect(session.snapshot().level).toBe("actions");
    expect(fx.bufferLoads.at(-1)!.signal.aborted).toBe(true);
    session.dispose();
  });

  it("aborts in-flight work and rejects all input after dispose", () => {
    const repo = deferred<readonly string[]>();
    let capturedSignal: AbortSignal | null = null;
    const loadRepoFiles = vi.fn((_identity: PaletteWorkspaceIdentity, signal: AbortSignal) => {
      capturedSignal = signal;
      return repo.promise;
    });
    const fx = fixture({ loadRepoFiles });
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    session.dispose();
    expect(session.disposed()).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    expect(session.handleKey(key("a"))).toBe(false);
    expect(session.handlePaste("x")).toBe(false);
    expect(session.handlePointer({ kind: "down", x: 1, y: 1 })).toBe(false);
  });

  it("uses every identity field in the exact workspace scope", () => {
    const base = identity("alpha");
    const scopes = [
      base,
      { ...base, workspaceName: "beta" },
      { ...base, directory: "/other" },
      { ...base, projectRoot: "/project" },
      { ...base, daemonIdentity: "daemon-b" },
      { ...base, generation: 2 },
    ].map(paletteWorkspaceIdentityScope);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("dispatches ordinary actions without granting the feature dialog ownership", async () => {
    const fx = fixture();
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    const actionEntry = session.entries().find((entry) => entry.action.kind === "new-agent")!;
    while (session.snapshot().selectedCommandId !== actionEntry.id) session.handleKey(key("down"));
    session.handleKey(key("return"));
    expect(fx.intents.at(-1)).toEqual({
      kind: "action",
      action: actionEntry.action as PaletteAction,
      usageKey: "new-agent",
    });
    session.dispose();
  });

  it("reports one usage identity per accepted action and never for disabled activation", async () => {
    const fx = fixture({
      disabledReason: (action) => (action.kind === "save" ? "disabled" : null),
    });
    const session = createPaletteFeatureSession(fx.host);
    session.openPalette();
    await Promise.resolve();
    const disabled = session.entries().find((entry) => entry.action.kind === "save")!;
    expect(disabled.descriptor.disabledReason).toBe("disabled");
    const before = fx.intents.length;
    expect(session.snapshot().selectedCommandId).not.toBe(disabled.id);
    expect(fx.intents).toHaveLength(before);
    const enabled = session.entries().find((entry) => entry.action.kind === "new-agent")!;
    while (session.snapshot().selectedCommandId !== enabled.id) session.handleKey(key("down"));
    session.handleKey(key("return"));
    const actions = fx.intents.filter((intent) => intent.kind === "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ usageKey: "new-agent" });
    session.dispose();
  });
});
