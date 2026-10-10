import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionRuntimeRegistry } from "./registry.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const intent = {
  verb: "workspace.window.split.resize" as const,
  workspaceName: "alpha",
  target: {
    window: {
      liveSessionId: "live-session.11111111111111111111",
      linkId: "window-link.11111111111141118111111111111111",
      expectedSemanticWindowId: "window.alpha",
      linkRevision: 1,
    },
    layoutId: "22222222-2222-4222-8222-222222222222",
    splitId: "33333333-3333-4333-8333-333333333333",
    boundary: 60,
  },
};
function setup() {
  let finish: (() => void) | undefined;
  let authorize: (() => void) | undefined;
  const entered = vi.fn();
  const registry = new SessionRuntimeRegistry({
    generation,
    semanticMutations: {
      resolveSession: () => "alpha",
      execute: (_id, _intent, _timing, _execution, fence) => {
        authorize = fence;
        entered();
        // Hold execution without performing any native effect. The test checks the final dispatch fence.
        return new Promise((_resolve, reject) => {
          finish = () => reject(new Error("test complete"));
        });
      },
      publishReceipt: (receipt) => ({ type: "interaction.receipt", sequence: 1, ...receipt }),
    },
  });
  const binder = new SessionRuntimeTransportBinder(registry);
  const bind = (explicitAuthority = true) =>
    binder.bind({
      transport: "pane-stream",
      transportLeaseId: randomUUID(),
      session: "alpha",
      hostClientId: "gpui:test",
      allowedSourcePaneIds: ["pane.a"],
      interactive: true,
      ownsGeometry: true,
      explicitAuthority,
    });
  return { registry, bind, entered, finish: () => finish?.(), authorize: () => authorize!() };
}
it("requires geometry ownership even when the transport owns input", async () => {
  const r = setup();
  const b = r.bind();
  try {
    b.requestAuthority("input");
    expect(() => b.submitIntent(randomUUID(), intent)).toThrow();
    expect(r.entered).not.toHaveBeenCalled();
  } finally {
    await b.close();
    await r.registry.dispose();
  }
});
it.each(["release", "replacement", "close"])(
  "rechecks geometry after async execution preparation: %s",
  async (action) => {
    const r = setup();
    const b = r.bind();
    let replacement: ReturnType<typeof r.bind> | undefined;
    try {
      b.requestAuthority("input");
      b.requestAuthority("geometry");
      void b.submitIntent(randomUUID(), intent).catch(() => {});
      await vi.waitFor(() => expect(r.entered).toHaveBeenCalledTimes(1));
      expect(() => r.authorize()).not.toThrow();
      if (action === "release") b.releaseAuthority("geometry");
      if (action === "replacement") {
        replacement = r.bind();
        replacement.requestAuthority("geometry");
      }
      if (action === "close") await b.close();
      expect(() => r.authorize()).toThrow();
    } finally {
      r.finish();
      await replacement?.close();
      await b.close();
      await r.registry.dispose();
    }
  },
);

it("rejects input-only and generic execution handles plus direct consumer and automation paths", async () => {
  const r = setup();
  const consumer = r.registry.connect("alpha", "web", "client:direct");
  const lease = consumer.acquireController();
  const generic = vi.fn();
  try {
    for (const callback of [undefined, generic]) {
      const handle = r.registry.createExecutionHandle(consumer, lease, ["pane.a"], callback);
      await expect(
        r.registry.submitAuthenticatedIntent(handle, randomUUID(), intent),
      ).rejects.toThrow("explicit geometry");
    }
    await expect(consumer.submitIntent(lease, randomUUID(), intent)).rejects.toThrow(
      "explicit geometry",
    );
    const { testInteractionContext } =
      await import("../../../test-support/interaction-evidence.ts");
    const context = testInteractionContext({
      verb: "workspace.pane.read",
      workspaceName: "alpha",
      semanticPaneId: "pane.a",
      origin: "sdk",
    });
    await expect(
      r.registry.submitAutomationIntent(randomUUID(), intent, {
        ...context,
        origin: "sdk",
        authorizeBeforeEffect: generic,
      }),
    ).rejects.toThrow("reads and sends only");
    expect(r.entered).not.toHaveBeenCalled();
  } finally {
    await r.registry.dispose();
  }
});

it("checks a separately supplied geometry authorizer after owner preparation", async () => {
  const r = setup();
  const consumer = r.registry.connect("alpha", "web", "client:direct");
  const lease = consumer.acquireController();
  let geometry = true;
  const handle = r.registry.createExecutionHandle(
    consumer,
    lease,
    ["pane.a"],
    () => {},
    () => {
      if (!geometry) throw new Error("geometry revoked");
    },
  );
  try {
    void r.registry.submitAuthenticatedIntent(handle, randomUUID(), intent).catch(() => {});
    await vi.waitFor(() => expect(r.entered).toHaveBeenCalledTimes(1));
    expect(() => r.authorize()).not.toThrow();
    geometry = false;
    expect(() => r.authorize()).toThrow("geometry revoked");
  } finally {
    r.finish();
    await r.registry.dispose();
  }
});
