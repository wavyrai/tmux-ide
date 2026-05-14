/**
 * W4 — Plan follow-up banner wire end-to-end (integration).
 *
 * `ComposerPlanFollowUpBanner` itself is unit-tested in
 * `ComposerPlanFollowUpBanner.test.tsx` (renders / disabled state /
 * button click → callback). These tests exercise the full plumbing:
 *
 *   daemon WS `chat.plan.upserted`  →  useChatThread.plans signal
 *                                  →  pendingPlan accessor
 *   button click                   →  approve / reject REST POST
 *   "Modify" click                 →  prefillPromptText signal
 *
 * They don't mount `ChatThreadView` (too many side effects); instead
 * they instantiate `useChatThread` directly and assert the public
 * accessors + the fetch surface. The banner component sits one render
 * layer above that — already covered by the unit tests.
 */

import { createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatThread } from "../src/hooks/useChatThread";
import type { ChatMountOptions, ProposedPlanSummary } from "../src/types";

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  messageListenerCount = 0;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close = vi.fn();
  send = vi.fn();

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "message") this.messageListenerCount += 1;
    super.addEventListener(type, callback, options);
  }
}

function actionResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(assertion()).toBe(true);
}

function pendingPlan(overrides: Partial<ProposedPlanSummary> = {}): ProposedPlanSummary {
  return {
    id: "plan-1",
    turnId: null,
    planMarkdown: "# Implement OAuth\n- step a\n- step b",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-05-13T08:00:00.000Z",
    updatedAt: "2026-05-13T08:00:00.000Z",
    ...overrides,
  };
}

function emptyThreadGet(): unknown {
  return {
    thread: {
      id: "thread-1",
      title: "New chat",
      createdAt: "2026-05-13T08:00:00.000Z",
      updatedAt: "2026-05-13T08:00:00.000Z",
      provider: { kind: "claude-code" },
      messages: [],
    },
  };
}

interface RouterOpts {
  initialPlans?: ProposedPlanSummary[];
  approveResponse?: { plan: ProposedPlanSummary; turnId: string };
  rejectResponse?: { plan: ProposedPlanSummary };
}

function createFetchRouter(opts: RouterOpts = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let plans: ProposedPlanSummary[] = opts.initialPlans ?? [];

  const router = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.endsWith("/api/v2/action/chat.thread.get")) {
      return actionResponse(emptyThreadGet());
    }
    if (url.endsWith("/api/v2/action/chat.thread.usage")) {
      return actionResponse({ usage: null });
    }
    if (url.includes("/api/project/") && url.endsWith("/panes")) {
      return jsonResponse({ panes: [] });
    }
    if (url.endsWith("/plans") && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ plans });
    }
    if (url.endsWith("/approve") && init?.method === "POST") {
      const next = opts.approveResponse ?? {
        plan: pendingPlan({
          implementedAt: "2026-05-13T08:05:00.000Z",
          implementationThreadId: "thread-1",
          updatedAt: "2026-05-13T08:05:00.000Z",
        }),
        turnId: "turn-1",
      };
      plans = plans.map((p) => (p.id === next.plan.id ? next.plan : p));
      return jsonResponse(next);
    }
    if (url.endsWith("/reject") && init?.method === "POST") {
      const next = opts.rejectResponse ?? {
        plan: pendingPlan({
          rejected: { at: "2026-05-13T08:05:00.000Z" },
          updatedAt: "2026-05-13T08:05:00.000Z",
        }),
      };
      plans = plans.map((p) => (p.id === next.plan.id ? next.plan : p));
      return jsonResponse(next);
    }
    return jsonResponse({ error: `no handler for ${url}` }, 404);
  });

  return { router, calls };
}

interface HostOpts extends RouterOpts {
  onMounted?: () => void;
}

function mountUseChatThread(opts: HostOpts = {}) {
  const { router, calls } = createFetchRouter(opts);
  globalThis.fetch = router as unknown as typeof fetch;

  let chat!: ReturnType<typeof useChatThread>;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    const [options] = createSignal<ChatMountOptions>({
      threadId: "thread-1",
      sessionName: "alpha",
      apiBaseUrl: "http://127.0.0.1:6060",
      wsUrl: "ws://127.0.0.1:6060/ws/chat",
      bearerToken: null,
    });
    chat = useChatThread(options as Accessor<ChatMountOptions>);
  });

  return { chat, dispose, calls, router };
}

function pushPlanUpserted(plan: ProposedPlanSummary): void {
  FakeWebSocket.instances[0]?.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "chat.plan.upserted",
        threadId: "thread-1",
        plan,
      }),
    }),
  );
}

describe("useChatThread + plan follow-up banner wiring (W4)", () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("surfaces pendingPlan when a chat.plan.upserted event lands", async () => {
    const { chat, dispose } = mountUseChatThread();
    await waitFor(() => (FakeWebSocket.instances[0]?.messageListenerCount ?? 0) > 0);

    pushPlanUpserted(pendingPlan({ id: "plan-A" }));

    await waitFor(() => chat.pendingPlan()?.id === "plan-A");
    expect(chat.pendingPlan()?.planMarkdown).toContain("Implement OAuth");
    dispose();
  });

  it("clears pendingPlan once the daemon emits an implementedAt timestamp", async () => {
    const { chat, dispose } = mountUseChatThread();
    await waitFor(() => (FakeWebSocket.instances[0]?.messageListenerCount ?? 0) > 0);

    pushPlanUpserted(pendingPlan({ id: "plan-A" }));
    await waitFor(() => chat.pendingPlan()?.id === "plan-A");

    pushPlanUpserted(
      pendingPlan({
        id: "plan-A",
        implementedAt: "2026-05-13T08:05:00.000Z",
        implementationThreadId: "thread-1",
        updatedAt: "2026-05-13T08:05:00.000Z",
      }),
    );

    await waitFor(() => chat.pendingPlan() === null);
    dispose();
  });

  it("approvePendingPlan POSTs /approve and clears the banner", async () => {
    const { chat, dispose, calls } = mountUseChatThread();
    await waitFor(() => (FakeWebSocket.instances[0]?.messageListenerCount ?? 0) > 0);

    pushPlanUpserted(pendingPlan({ id: "plan-A" }));
    await waitFor(() => chat.pendingPlan()?.id === "plan-A");

    await chat.approvePendingPlan("plan-A");

    const approveCall = calls.find((call) => call.url.endsWith("/plan-A/approve"));
    expect(approveCall).toBeTruthy();
    expect(approveCall?.init?.method).toBe("POST");
    expect(chat.pendingPlan()).toBeNull();
    expect(chat.planResponding()).toBe(false);
    dispose();
  });

  it("rejectPendingPlan POSTs /reject with optional reason and clears the banner", async () => {
    const { chat, dispose, calls } = mountUseChatThread();
    await waitFor(() => (FakeWebSocket.instances[0]?.messageListenerCount ?? 0) > 0);

    pushPlanUpserted(pendingPlan({ id: "plan-A" }));
    await waitFor(() => chat.pendingPlan()?.id === "plan-A");

    await chat.rejectPendingPlan("plan-A", "scope too big");

    const rejectCall = calls.find((call) => call.url.endsWith("/plan-A/reject"));
    expect(rejectCall).toBeTruthy();
    expect(rejectCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(rejectCall?.init?.body ?? "{}"))).toEqual({
      reason: "scope too big",
    });
    expect(chat.pendingPlan()).toBeNull();
    dispose();
  });

  it("modifyPendingPlan prefills the composer with the plan markdown", async () => {
    const { chat, dispose } = mountUseChatThread();
    await waitFor(() => (FakeWebSocket.instances[0]?.messageListenerCount ?? 0) > 0);

    const plan = pendingPlan({ id: "plan-A" });
    pushPlanUpserted(plan);
    await waitFor(() => chat.pendingPlan()?.id === "plan-A");

    chat.modifyPendingPlan("plan-A");
    expect(chat.prefillPromptText()).toBe(plan.planMarkdown);
    // Pending plan stays — modify is a "stage in composer" affordance,
    // not a daemon-side state transition.
    expect(chat.pendingPlan()?.id).toBe("plan-A");
    dispose();
  });
});
