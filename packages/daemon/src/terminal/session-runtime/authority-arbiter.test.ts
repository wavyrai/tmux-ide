import { describe, expect, it } from "vitest";
import type { SessionRuntimeScheduler, SessionRuntimeTimer } from "./runtime-scheduler.ts";
import { SessionRuntimeAuthorityArbiter } from "./authority-arbiter.ts";

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

function deterministicScheduler() {
  let now = 0;
  let id = 0;
  const timers: Array<{ at: number; task: () => void; cancelled: boolean }> = [];
  const scheduler: SessionRuntimeScheduler = {
    nowMs: () => now,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    microtask: (task) => task(),
    timer: (task, delayMs): SessionRuntimeTimer => {
      const timer = { at: now + delayMs, task, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  };
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const timer of timers
      .filter((candidate) => !candidate.cancelled && candidate.at <= now)
      .sort((a, b) => a.at - b.at)) {
      timer.cancelled = true;
      timer.task();
    }
  };
  return { scheduler, advance };
}

describe("SessionRuntimeAuthorityArbiter", () => {
  it("elects input, focus and geometry independently", () => {
    const { scheduler } = deterministicScheduler();
    const authority = new SessionRuntimeAuthorityArbiter({
      generation: GENERATION_A,
      session: "alpha",
      scheduler,
    });
    authority.connect("client:web", "web");
    authority.connect("client:tui", "opentui");
    authority.updatePresence("client:web", "foreground");
    authority.updatePresence("client:tui", "foreground");

    expect(authority.claim("client:web", "input")?.clientId).toBe("client:web");
    expect(authority.claim("client:web", "focus")?.clientId).toBe("client:web");
    expect(authority.claim("client:tui", "geometry")?.clientId).toBe("client:tui");
    expect(authority.snapshot().owners).toEqual({
      input: "client:web",
      focus: "client:web",
      geometry: "client:tui",
    });
  });

  it("reorders foreground geometry deterministically and retires it on disconnect", () => {
    const { scheduler } = deterministicScheduler();
    const authority = new SessionRuntimeAuthorityArbiter({
      generation: GENERATION_A,
      session: "alpha",
      scheduler,
    });
    authority.connect("client:web", "web");
    authority.connect("client:tui", "opentui");
    authority.updatePresence("client:web", "foreground");
    authority.claim("client:web", "geometry");
    authority.claim("client:tui", "geometry");
    expect(authority.snapshot().owners.geometry).toBe("client:web");

    authority.updatePresence("client:web", "background");
    authority.updatePresence("client:tui", "foreground");
    const tuiLease = authority.leaseFor("client:tui", "geometry");
    expect(tuiLease?.clientId).toBe("client:tui");

    authority.disconnect("client:tui");
    expect(authority.snapshot().owners.geometry).toBeNull();
    expect(() => authority.assertLease(tuiLease!)).toThrow("Stale geometry authority lease");

    authority.updatePresence("client:web", "foreground");
    expect(authority.snapshot().owners.geometry).toBe("client:web");
  });

  it("yields immediately to native tmux and waits for a deterministic quiet period", () => {
    const { scheduler, advance } = deterministicScheduler();
    const authority = new SessionRuntimeAuthorityArbiter({
      generation: GENERATION_A,
      session: "alpha",
      scheduler,
      nativeGeometryHysteresisMs: 180,
    });
    authority.connect("client:web", "web");
    authority.updatePresence("client:web", "foreground");
    const stale = authority.claim("client:web", "geometry")!;

    authority.noteNativeGeometryActivity();
    expect(authority.snapshot().owners.geometry).toBeNull();
    expect(() => authority.assertLease(stale)).toThrow("Stale geometry authority lease");
    advance(179);
    expect(authority.snapshot().owners.geometry).toBeNull();
    advance(1);
    expect(authority.snapshot().owners.geometry).toBe("client:web");
  });

  it("fences leases across daemon generation restart", () => {
    const firstRig = deterministicScheduler();
    const first = new SessionRuntimeAuthorityArbiter({
      generation: GENERATION_A,
      session: "alpha",
      scheduler: firstRig.scheduler,
    });
    first.connect("client:web", "web");
    first.updatePresence("client:web", "foreground");
    const oldLease = first.claim("client:web", "input")!;
    first.dispose();

    const secondRig = deterministicScheduler();
    const second = new SessionRuntimeAuthorityArbiter({
      generation: GENERATION_B,
      session: "alpha",
      scheduler: secondRig.scheduler,
    });
    second.connect("client:web", "web");
    second.updatePresence("client:web", "foreground");
    const current = second.claim("client:web", "input")!;

    expect(current.generation).toBe(GENERATION_B);
    expect(() => second.assertLease(oldLease)).toThrow("Stale input authority lease");
  });
});
