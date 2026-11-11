import { afterEach, describe, expect, it, vi } from "vitest";
import { HOME_AGENT_WAIT_MS, waitForHomeAgentListed } from "./application-home-agents-owner.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

/** A fake attached generation whose semantic publications the test drives. */
function attached() {
  const listeners = new Set<() => void>();
  const state = { agents: [] as { id: string; paneId: string }[], renderer: 1 };
  const client = {
    getSnapshot: () => ({ generation: 3, semantic: { sidebar: { agents: state.agents } } }),
    subscribe: (_scope: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const generation = () =>
    ({
      status: "live",
      daemonGeneration: "daemon",
      rendererEpoch: state.renderer,
      client,
    }) as unknown as OpenTuiGenerationHostSnapshot;
  const publish = () => {
    for (const listener of [...listeners]) listener();
  };
  const listed = () => state.agents.some((a) => a.id === "agent" && a.paneId === "pane.agent");
  return { state, generation, publish, listed, listeners, key: "daemon:3:1" };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForHomeAgentListed (#764)", () => {
  it("resolves true when the session publishes the agent", async () => {
    const a = attached();
    const wait = waitForHomeAgentListed(
      a.generation,
      a.key,
      a.listed,
      new AbortController().signal,
    );
    a.state.agents = [{ id: "agent", paneId: "pane.agent" }];
    a.publish();
    await expect(wait).resolves.toBe(true);
    expect(a.listeners.size).toBe(0);
  });

  it("resolves false at the cold path's 5 s bound", async () => {
    vi.useFakeTimers();
    const a = attached();
    const wait = waitForHomeAgentListed(
      a.generation,
      a.key,
      a.listed,
      new AbortController().signal,
    );
    vi.advanceTimersByTime(HOME_AGENT_WAIT_MS - 1);
    a.publish();
    vi.advanceTimersByTime(1);
    await expect(wait).resolves.toBe(false);
    expect(HOME_AGENT_WAIT_MS).toBe(5_000);
  });

  it("settles on a different generation, for the navigator to refuse", async () => {
    const a = attached();
    const wait = waitForHomeAgentListed(
      a.generation,
      a.key,
      a.listed,
      new AbortController().signal,
    );
    a.state.renderer = 2;
    a.publish();
    await expect(wait).resolves.toBe(true);
  });

  it("resolves false when aborted", async () => {
    const a = attached();
    const abort = new AbortController();
    const wait = waitForHomeAgentListed(a.generation, a.key, a.listed, abort.signal);
    abort.abort();
    await expect(wait).resolves.toBe(false);
  });
});
