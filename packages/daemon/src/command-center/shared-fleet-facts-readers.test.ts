import { describe, expect, it, vi } from "vitest";
import {
  createSharedFleetFactsReaders,
  FLEET_FACTS_TMUX_ARGS,
} from "./daemon-fleet-facts-observer.ts";

const topology = "alpha\t1\t41\t$0\t100\t@1\t%1\t1\t1\tpane.a\twindow.a";
const row = `${topology}\tIDLE\tcodex`;
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared fleet facts readers", () => {
  it("shares a query across concurrent demands without caching completed snapshots", async () => {
    const run = vi.fn().mockResolvedValue(row);
    const readers = createSharedFleetFactsReaders(run);
    const [sessions, agents] = await Promise.all([readers.readSessions(), readers.readAgents()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(FLEET_FACTS_TMUX_ARGS);
    expect(sessions).toEqual({
      sessions: ["alpha"],
      adopted: ["alpha"],
      terminalTopology: [topology],
    });
    expect(agents?.get("alpha")?.get("%1")).toEqual({
      paneStamp: "pane.a",
      state: "IDLE",
      command: "codex",
    });
    run.mockResolvedValue(row.replace("IDLE", "BUSY"));
    const [nextSessions, nextAgents] = await Promise.all([
      readers.readSessions(),
      readers.readAgents(),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(nextSessions).toEqual(sessions);
    expect(nextAgents?.get("alpha")?.get("%1")?.state).toBe("BUSY");
  });

  it("keeps the query alive for the remaining reader and quarantines cancelled reads until settlement", async () => {
    const reply = deferred();
    let underlying!: AbortSignal;
    const readers = createSharedFleetFactsReaders((_args, signal) => {
      underlying = signal!;
      return reply.promise;
    });
    const cancelled = new AbortController();
    const sessions = readers.readSessions(cancelled.signal);
    const agents = readers.readAgents();
    let settled = false;
    void sessions.then(() => {
      settled = true;
    });
    await Promise.resolve();
    cancelled.abort();
    await Promise.resolve();
    expect(underlying.aborted).toBe(false);
    expect(settled).toBe(false);
    reply.resolve(row);
    expect(await sessions).toBeNull();
    expect((await agents)?.get("alpha")?.size).toBe(1);
  });

  it("aborts the last reader without letting an old completion clear a successor query", async () => {
    const first = deferred();
    const second = deferred();
    const signals: AbortSignal[] = [];
    const run = vi.fn((_args, signal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const readers = createSharedFleetFactsReaders(run);
    const one = new AbortController();
    const two = new AbortController();
    const sessions = readers.readSessions(one.signal);
    const agents = readers.readAgents(two.signal);
    await Promise.resolve();
    one.abort();
    expect(signals[0]?.aborted).toBe(false);
    two.abort();
    expect(signals[0]?.aborted).toBe(true);
    const successor = readers.readSessions();
    await Promise.resolve();
    first.resolve(row);
    expect(await sessions).toBeNull();
    expect(await agents).toBeNull();
    const successorAgents = readers.readAgents();
    expect(run).toHaveBeenCalledTimes(2);
    second.resolve(row.replace("alpha", "beta"));
    expect((await successor)?.sessions).toEqual(["beta"]);
    expect((await successorAgents)?.has("beta")).toBe(true);
  });

  it("treats absent servers as empty sessions, not successful empty agent observations", async () => {
    const missing = new Error("absent");
    const readers = createSharedFleetFactsReaders(
      () => {
        throw missing;
      },
      (error) => error === missing,
    );
    const [sessions, agents] = await Promise.all([readers.readSessions(), readers.readAgents()]);
    expect(sessions?.sessions).toEqual([]);
    expect(agents).toBeNull();
    const failed = createSharedFleetFactsReaders(() => {
      throw new Error("other");
    });
    expect(await failed.readSessions()).toBeNull();
  });

  it("does not launch for pre-cancelled callers or accept malformed agent rows", async () => {
    const run = vi.fn().mockResolvedValue(`${row}\textra`);
    const readers = createSharedFleetFactsReaders(run);
    const controller = new AbortController();
    controller.abort();
    expect(await readers.readAgents(controller.signal)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(await readers.readAgents()).toEqual(new Map());
  });
});
