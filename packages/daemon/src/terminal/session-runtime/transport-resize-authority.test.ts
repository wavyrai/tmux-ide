import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionRuntimeRegistry } from "./registry.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const intent = {
  verb: "workspace.pane.resize" as const,
  workspaceName: "alpha",
  semanticPaneId: "pane.a",
  axis: "cols" as const,
  cells: 60,
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

it("preserves legacy geometry acquisition but retires its captured operation lease", async () => {
  const r = setup();
  const b = r.bind(false);
  try {
    void b.submitIntent(randomUUID(), intent).catch(() => {});
    await vi.waitFor(() => expect(r.entered).toHaveBeenCalledTimes(1));
    expect(() => r.authorize()).not.toThrow();
    b.releaseAuthority("geometry");
    expect(() => r.authorize()).toThrow();
  } finally {
    r.finish();
    await b.close();
    await r.registry.dispose();
  }
});
