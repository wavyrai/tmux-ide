import { describe, expect, it, vi } from "vitest";

import { createApplicationHostFocusControlBindingObserver } from "./application-host-focus-control-binding.ts";
import { resolveApplicationHostFocusControlCapability } from "./application-host-focus-control-capability.ts";

const generation = "daemon-generation-a";

function client(initialPhase: "connecting" | "live" = "connecting") {
  let phase = initialPhase;
  const listeners = new Set<() => void>();
  const staleListeners: Array<() => void> = [];
  const value = {
    authorityIdentity: {
      generation,
      session: "runtime-session-a",
      clientId: "opentui:42",
    },
    getSnapshot: () => ({
      generation: 7,
      phase,
      target: { daemon: { instanceId: generation }, workspaceName: "workspace-a" },
    }),
    getAuthoritySnapshot: vi.fn(() => null),
    setPresence: vi.fn(),
    noteActivity: vi.fn(),
    requestAuthority: vi.fn(),
    releaseAuthority: vi.fn(),
    onAuthority: vi.fn(() => () => undefined),
    onBinding: vi.fn((listener: () => void) => {
      listeners.add(listener);
      staleListeners.push(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    value,
    phase(next: "connecting" | "live") {
      phase = next;
      for (const listener of [...listeners]) listener();
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    emitStale() {
      for (const listener of staleListeners) listener();
    },
  };
}

function host(authorityClient: ReturnType<typeof client>["value"], rendererEpoch = 3) {
  return { status: "live", rendererEpoch, daemonGeneration: generation, authorityClient } as const;
}

describe("Card5 host-focus control capability and binding", () => {
  it("uses one exact capability gate and reports every rejected conjunct", () => {
    const exact = {
      TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "1",
      TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: "/private/hf.sock",
      TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: "/private",
      TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY: "1".repeat(64),
      TMUX_IDE_PERFORMANCE_TRACE_DETAIL: "1",
      TMUX_IDE_TUI_PERF_LOG: "/private/performance.jsonl",
    };
    const resolved = resolveApplicationHostFocusControlCapability(exact);
    expect(resolved.enabled).toBe(true);
    expect(resolved.observation).toEqual({
      capability: true,
      detail: true,
      path: true,
      root: true,
      key: true,
      trace: true,
      enabled: true,
    });
    for (const [field, changed] of [
      ["capability", { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "0" }],
      ["detail", { TMUX_IDE_PERFORMANCE_TRACE_DETAIL: "0" }],
      ["path", { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: "/outside/hf.sock" }],
      ["root", { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: "relative" }],
      ["key", { TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY: "bad" }],
      ["trace", { TMUX_IDE_TUI_PERF_LOG: "" }],
    ] as const) {
      const rejected = resolveApplicationHostFocusControlCapability({ ...exact, ...changed });
      expect(rejected.enabled).toBe(false);
      expect(rejected.observation[field]).toBe(false);
    }
  });

  it("publishes delayed and immediate live bindings exactly once per owned epoch", () => {
    const first = client();
    let current = host(first.value);
    const published: unknown[] = [];
    const observer = createApplicationHostFocusControlBindingObserver({
      enabled: true,
      currentHost: () => current,
      publish: (identity) => published.push(identity),
    });
    observer.adopt(current);
    expect(observer.current()).toBeNull();
    first.phase("live");
    expect(published).toHaveLength(1);
    first.emit();
    observer.adopt(current);
    expect(published).toHaveLength(1);

    const second = client("live");
    current = host(second.value, 4);
    observer.adopt(current);
    expect(published).toHaveLength(2);
    expect(observer.current()).toMatchObject({ bindingEpoch: 2, rendererEpoch: 4 });
    first.emitStale();
    expect(published).toHaveLength(2);

    current = host(first.value, 5);
    observer.adopt(current);
    expect(published).toHaveLength(3);
    expect(observer.current()).toMatchObject({ bindingEpoch: 3, rendererEpoch: 5 });
    observer.dispose();
    first.emitStale();
    expect(observer.current()).toBeNull();
    expect(published).toHaveLength(3);
  });

  it("never publishes while the capability gate is disabled", () => {
    const active = client("live");
    let current = host(active.value);
    const publish = vi.fn();
    const observer = createApplicationHostFocusControlBindingObserver({
      enabled: false,
      currentHost: () => current,
      publish,
    });
    observer.adopt(current);
    active.emit();
    expect(observer.current()).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    current = host(active.value, 4);
    observer.adopt(current);
    expect(publish).not.toHaveBeenCalled();
  });
});
