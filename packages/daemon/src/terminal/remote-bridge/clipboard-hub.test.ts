import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteClipboardEvent } from "@tmux-ide/contracts";
import { REMOTE_CLIPBOARD_WINDOW_MS, RemoteClipboardHub } from "./clipboard-hub.ts";

const write = (paneId: string, text: string): RemoteClipboardEvent => ({
  type: "clipboard.write",
  session: "s",
  paneId,
  incarnation: "g:0",
  bytes: Buffer.byteLength(text),
  text,
});

describe("RemoteClipboardHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers the first write at once to every subscriber", () => {
    const hub = new RemoteClipboardHub();
    const a: RemoteClipboardEvent[] = [];
    const b: RemoteClipboardEvent[] = [];
    hub.subscribe((event) => a.push(event));
    hub.subscribe((event) => b.push(event));
    hub.publish(write("p1", "one"));
    expect(a).toEqual([write("p1", "one")]);
    expect(b).toEqual([write("p1", "one")]);
  });

  it("keeps no copy for a later subscriber", () => {
    const hub = new RemoteClipboardHub();
    hub.publish(write("p1", "early"));
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS * 2);
    const seen: RemoteClipboardEvent[] = [];
    hub.subscribe((event) => seen.push(event));
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS * 2);
    expect(seen).toEqual([]);
  });

  it("caps one pane at one write per window and lets the last one win", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.type === "clipboard.write" ? event.text : "refused"));
    hub.publish(write("p1", "a"));
    hub.publish(write("p1", "b"));
    hub.publish(write("p1", "c"));
    expect(seen).toEqual(["a"]);
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS - 1);
    expect(seen).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["a", "c"]);
  });

  it("stays within four writes a second under a flood", () => {
    const hub = new RemoteClipboardHub();
    const times: number[] = [];
    hub.subscribe(() => times.push(Date.now()));
    const start = Date.now();
    for (let ms = 0; ms < 1000; ms += 5) {
      hub.publish(write("p1", `t${ms}`));
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS);
    const inFirstSecond = times.filter((t) => t - start < 1000).length;
    expect(inFirstSecond).toBeLessThanOrEqual(4);
    for (let i = 1; i < times.length; i += 1)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(REMOTE_CLIPBOARD_WINDOW_MS);
  });

  it("sends a held write when its window ends, not a full window after it was held", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.type === "clipboard.write" ? event.text : ""));
    hub.publish(write("p1", "a"));
    vi.advanceTimersByTime(200);
    hub.publish(write("p1", "b"));
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS - 200);
    expect(seen).toEqual(["a", "b"]);
  });

  it("keeps order when the window's timer runs late", () => {
    let clock = 0;
    const hub = new RemoteClipboardHub(() => clock);
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.type === "clipboard.write" ? event.text : ""));
    hub.publish(write("p1", "a"));
    hub.publish(write("p1", "b"));
    // The clock passes the window but the held write's timer has not run yet.
    clock += REMOTE_CLIPBOARD_WINDOW_MS * 4;
    hub.publish(write("p1", "c"));
    expect(seen).toEqual(["a"]);
    vi.runOnlyPendingTimers();
    expect(seen).toEqual(["a", "c"]);
  });

  it("never forgets a pane that still holds a write", () => {
    let clock = 0;
    const hub = new RemoteClipboardHub(() => clock);
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.type === "clipboard.write" ? event.text : ""));
    hub.publish(write("held", "a"));
    hub.publish(write("held", "b"));
    for (let i = 0; i < 300; i += 1) hub.publish(write(`p${i}`, "x"));
    clock += REMOTE_CLIPBOARD_WINDOW_MS * 4;
    hub.publish(write("trigger", "x"));
    vi.runOnlyPendingTimers();
    expect(seen.filter((text) => text !== "x")).toEqual(["a", "b"]);
  });

  it("delivers the flood's last write", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.type === "clipboard.write" ? event.text : ""));
    for (let i = 0; i < 50; i += 1) hub.publish(write("p1", `t${i}`));
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS);
    expect(seen).toEqual(["t0", "t49"]);
  });

  it("does not let one pane's flood delay another pane", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.paneId));
    hub.publish(write("p1", "a"));
    hub.publish(write("p1", "b"));
    hub.publish(write("p2", "x"));
    expect(seen).toEqual(["p1", "p2"]);
  });

  it("sends a write at once after a quiet window", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    hub.subscribe((event) => seen.push(event.type === "clipboard.write" ? event.text : ""));
    hub.publish(write("p1", "a"));
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS);
    hub.publish(write("p1", "b"));
    expect(seen).toEqual(["a", "b"]);
  });

  it("stops delivering to an unsubscribed listener and survives a throwing one", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    hub.subscribe(() => {
      throw new Error("boom");
    });
    const stop = hub.subscribe((event) => seen.push(event.paneId));
    hub.publish(write("p1", "a"));
    stop();
    hub.publish(write("p2", "b"));
    expect(seen).toEqual(["p1"]);
  });

  it("drops a write held for a pane when nobody is listening any more", () => {
    const hub = new RemoteClipboardHub();
    const seen: string[] = [];
    const stop = hub.subscribe((event) => seen.push(event.paneId));
    hub.publish(write("p1", "a"));
    hub.publish(write("p1", "b"));
    stop();
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS);
    expect(seen).toEqual(["p1"]);
    expect(hub.trackedPanes()).toBe(0);
  });

  it("forgets quiet panes so the table stays bounded", () => {
    const hub = new RemoteClipboardHub();
    hub.subscribe(() => {});
    for (let i = 0; i < 5000; i += 1) hub.publish(write(`p${i}`, "a"));
    vi.advanceTimersByTime(REMOTE_CLIPBOARD_WINDOW_MS);
    hub.publish(write("last", "a"));
    expect(hub.trackedPanes()).toBeLessThanOrEqual(1);
  });

  it("publishes nothing while nobody listens", () => {
    const hub = new RemoteClipboardHub();
    hub.publish(write("p1", "a"));
    expect(hub.trackedPanes()).toBe(0);
  });
});
