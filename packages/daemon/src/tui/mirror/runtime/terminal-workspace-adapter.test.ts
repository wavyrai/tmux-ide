import { describe, expect, it, vi } from "vitest";
import type { OpenTuiSessionRuntimeLane } from "../application-shell-daemon-runtime.ts";
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
    workspaceName: name,
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

    adapter.connect("generation-a", async () => first);
    await settle();
    expect(adapter.lane).toBe(first);
    expect(adapter.sendText("pane.editor", "hello")).toBe(true);
    expect(first.sendText).toHaveBeenCalledWith("pane.editor", "hello");

    adapter.connect("generation-b", async () => second);
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(adapter.lane).toBe(second);
    expect(adapter.view).toBe(view);
    expect(adapter.renderSource).toBe(source);

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
});
