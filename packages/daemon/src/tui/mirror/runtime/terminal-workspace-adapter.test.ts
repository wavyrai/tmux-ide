import { describe, expect, it, vi } from "vitest";
import type { OpenTuiSessionRuntimeLane } from "../application-shell-daemon-runtime.ts";
import { installTuiPerformanceEventSink } from "../performance-events.ts";
import { SemanticTerminalRenderSource } from "../semantic-pane-render-source.ts";
import { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import { OpenTuiTerminalWorkspaceAdapter } from "./terminal-workspace-adapter.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function lane(name: string): OpenTuiSessionRuntimeLane {
  return {
    daemonInstanceId: "00000000-0000-4000-8000-000000000001",
    workspaceName: name,
    generation: "00000000-0000-4000-8000-000000000001",
    connectionIdentity: name,
    viewerMode: "interactive",
    ownsInput: true,
    ownsGeometry: true,
    source: new SemanticTerminalRenderSource(),
    sendText: vi.fn(),
    sendKey: vi.fn(),
    fitViewport: vi.fn(async () => {}),
    submit: vi.fn(async () => null),
    close: vi.fn(),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OpenTUI terminal workspace adapter", () => {
  it("retains view and framebuffer identities while replacing the fast lane", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    lifecycle.registerCloser("terminal-workspace", () => adapter.dispose());
    const view = adapter.view;
    const source = adapter.renderSource;
    const first = lane("alpha");
    const second = lane("alpha-next");
    const initialRenderEpoch = adapter.renderEpoch;

    adapter.connect("generation-a", async () => first);
    await settle();
    expect(adapter.lane).toBe(first);
    expect(adapter.renderEpoch).toBeGreaterThan(initialRenderEpoch);
    expect(adapter.sendText("pane.editor", "hello")).toBe(true);
    expect(first.sendText).toHaveBeenCalledWith("pane.editor", "hello");

    adapter.connect("generation-b", async () => second);
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(adapter.lane).toBe(second);
    expect(adapter.view).toBe(view);
    expect(adapter.renderSource).toBe(source);
    expect(adapter.renderEpoch).toBeGreaterThan(initialRenderEpoch + 1);

    await lifecycle.shutdown("host");
    expect(second.close).toHaveBeenCalledOnce();
    expect(adapter.sendKey("pane.editor", "C-c")).toBe(false);
  });

  it("retires a runtime that resolves after shutdown without adopting it", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    lifecycle.registerCloser("terminal-workspace", () => adapter.dispose());
    const pending = deferred<OpenTuiSessionRuntimeLane | null>();
    const late = lane("late");

    adapter.connect("generation-a", () => pending.promise);
    await lifecycle.shutdown("host");
    pending.resolve(late);
    await settle();

    expect(adapter.lane).toBeNull();
    expect(late.close).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate same-key connects without invalidating the pending owner", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    lifecycle.registerCloser("terminal-workspace", () => adapter.dispose());
    const pending = deferred<OpenTuiSessionRuntimeLane | null>();
    const connected = lane("alpha");
    const duplicateFactory = vi.fn(async () => lane("duplicate"));

    adapter.connect("generation-a", () => pending.promise);
    adapter.connect("generation-a", duplicateFactory);
    pending.resolve(connected);
    await settle();

    expect(duplicateFactory).not.toHaveBeenCalled();
    expect(adapter.lane).toBe(connected);
    expect(connected.close).not.toHaveBeenCalled();
    await lifecycle.shutdown("host");
  });

  it("allows the same key to retry after an unavailable runtime", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    lifecycle.registerCloser("terminal-workspace", () => adapter.dispose());
    const connected = lane("alpha");

    adapter.connect("generation-a", async () => null);
    await settle();
    adapter.connect("generation-a", async () => connected);
    await settle();

    expect(adapter.lane).toBe(connected);
    await lifecycle.shutdown("host");
  });

  it("keeps pane subscribers stable while fencing replacement and disposal generations", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    lifecycle.registerCloser("terminal-workspace", () => adapter.dispose());
    const editor = vi.fn();
    const tests = vi.fn();
    adapter.subscribePaneVersion("pane.editor", editor);
    adapter.subscribePaneVersion("pane.tests", tests);

    const retiringGeneration = adapter.beginPaneGeneration();
    expect(adapter.publishPaneVersion(retiringGeneration, "pane.editor", 1)).toBe(true);

    const replacementGeneration = adapter.beginPaneGeneration();
    expect(adapter.publishPaneVersion(retiringGeneration, "pane.editor", 2)).toBe(false);
    expect(adapter.publishPaneVersion(replacementGeneration, "pane.editor", 1)).toBe(true);
    expect(editor.mock.calls).toEqual([[1], [2]]);
    expect(tests).not.toHaveBeenCalled();

    await lifecycle.shutdown("host");
    expect(adapter.publishPaneVersion(replacementGeneration, "pane.editor", 2)).toBe(false);
    expect(editor).toHaveBeenCalledTimes(2);
  });

  it("allocates and forwards a trace only while an opt-in input observer is installed", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    const connected = lane("alpha");
    adapter.connect("generation-a", async () => connected);
    await settle();
    const finish = vi.fn();
    const cancel = vi.fn();
    const remove = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      beginTerminalInput: () => ({
        traceId: "00000000-0000-4000-8000-000000000001",
        finish,
        cancel,
      }),
    });
    try {
      expect(adapter.sendKey("pane.editor", "Enter")).toBe(true);
      expect(connected.sendKey).toHaveBeenCalledWith(
        "pane.editor",
        "Enter",
        "00000000-0000-4000-8000-000000000001",
      );
      expect(finish).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      remove();
      await lifecycle.shutdown("host");
    }
  });

  it("cancels an input trace when the control lane rejects the send", async () => {
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const adapter = new OpenTuiTerminalWorkspaceAdapter({ target: "alpha", lifecycle });
    const connected = lane("alpha");
    vi.mocked(connected.sendText).mockImplementation(() => {
      throw new Error("send failed");
    });
    adapter.connect("generation-a", async () => connected);
    await settle();
    const finish = vi.fn();
    const cancel = vi.fn();
    const remove = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      beginTerminalInput: () => ({
        traceId: "00000000-0000-4000-8000-000000000002",
        finish,
        cancel,
      }),
    });
    try {
      expect(() => adapter.sendText("pane.editor", "hello")).toThrow("send failed");
      expect(cancel).toHaveBeenCalledOnce();
      expect(finish).not.toHaveBeenCalled();
    } finally {
      remove();
      await lifecycle.shutdown("host");
    }
  });
});
