import { afterEach, expect, it, vi } from "vitest";
import { MirrorService } from "../mirror/mirror-service.ts";
import { SessionRuntimeRegistry } from "./registry.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";
let leaseCounter = 0;

function bindViewer(binder: SessionRuntimeTransportBinder, hostClientId: string) {
  leaseCounter += 1;
  return binder.bind({
    transport: "pane-stream",
    transportLeaseId: `00000000-0000-4000-8000-${leaseCounter.toString().padStart(12, "0")}`,
    session: "alpha",
    hostClientId,
    allowedSourcePaneIds: ["pane.editor"],
    interactive: true,
    ownsGeometry: true,
    explicitAuthority: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps the holder's lease when a handoff is refused during topology verification", async () => {
  const registry = new SessionRuntimeRegistry({ generation: GENERATION });
  const binder = new SessionRuntimeTransportBinder(registry);
  const first = bindViewer(binder, "gpui:first");
  const second = bindViewer(binder, "gpui:second");
  expect(first.requestAuthority("input")?.clientId).toBe("gpui:first");

  // A freshly created session verifies window ownership while the next viewer
  // opens it. The refused handoff must not orphan the controller.
  const topology = vi
    .spyOn(MirrorService.prototype, "windowOwnershipMessage")
    .mockReturnValue("Window ownership is being verified");
  expect(() => second.requestAuthority("input")).toThrowError(
    expect.objectContaining({ code: "controller-conflict" }),
  );
  topology.mockReturnValue(null);
  first.assertController("pane.editor");

  expect(second.requestAuthority("input")?.clientId).toBe("gpui:second");
  second.assertController("pane.editor");
  expect(() => first.assertController("pane.editor")).toThrowError(
    expect.objectContaining({ code: "stale-controller-lease" }),
  );
  await first.close();
  await second.close();
  await registry.dispose();
});

it("retires the controller when the last transport closes even if lease release throws", async () => {
  const registry = new SessionRuntimeRegistry({ generation: GENERATION });
  const binder = new SessionRuntimeTransportBinder(registry);
  const ghost = bindViewer(binder, "gpui:ghost");
  expect(ghost.requestAuthority("input")?.clientId).toBe("gpui:ghost");
  const probe = registry.connect("alpha", "pane-stream", "probe");
  vi.spyOn(Object.getPrototypeOf(probe), "releaseController").mockImplementationOnce(() => {
    throw new Error("release refused");
  });

  await expect(ghost.close()).rejects.toThrow("release refused");
  expect(probe.controllerSnapshot().controllerClientId).toBeNull();

  const next = bindViewer(binder, "gpui:next");
  expect(next.requestAuthority("input")?.clientId).toBe("gpui:next");
  next.assertController("pane.editor");
  await next.close();
  await probe.close();
  await registry.dispose();
});

it("lets the next viewer reclaim a controller whose holder lost its lease", async () => {
  const registry = new SessionRuntimeRegistry({ generation: GENERATION });
  const binder = new SessionRuntimeTransportBinder(registry);
  const orphan = bindViewer(binder, "gpui:orphan");
  expect(orphan.requestAuthority("input")?.clientId).toBe("gpui:orphan");
  const probe = registry.connect("alpha", "pane-stream", "probe");
  // Any failed surrender leaves the runtime naming a client whose transport no
  // longer holds an executable lease.
  vi.spyOn(Object.getPrototypeOf(probe), "releaseController").mockImplementationOnce(() => {
    throw new Error("release refused");
  });
  expect(() => orphan.releaseAuthority("input")).toThrow("release refused");
  expect(probe.controllerSnapshot().controllerClientId).toBe("gpui:orphan");
  expect(() => orphan.assertController("pane.editor")).toThrowError(
    expect.objectContaining({ code: "stale-controller-lease" }),
  );

  const next = bindViewer(binder, "gpui:next");
  expect(next.requestAuthority("input")?.clientId).toBe("gpui:next");
  next.assertController("pane.editor");
  expect(probe.controllerSnapshot().controllerClientId).toBe("gpui:next");
  expect(() => orphan.assertController("pane.editor")).toThrowError(
    expect.objectContaining({ code: "stale-controller-lease" }),
  );

  // The former holder can still ask again; ordinary handoff keeps one typist.
  expect(orphan.requestAuthority("input")?.clientId).toBe("gpui:orphan");
  orphan.assertController("pane.editor");
  expect(() => next.assertController("pane.editor")).toThrowError(
    expect.objectContaining({ code: "stale-controller-lease" }),
  );
  await orphan.close();
  await next.close();
  await probe.close();
  await registry.dispose();
});

it("never reclaims a controller held by a principal outside the transport binder", async () => {
  const registry = new SessionRuntimeRegistry({ generation: GENERATION });
  const binder = new SessionRuntimeTransportBinder(registry);
  const owner = registry.connect("alpha", "command-center", "command-center:owner");
  owner.acquireController();
  const viewer = bindViewer(binder, "gpui:viewer");
  expect(() => viewer.requestAuthority("input")).toThrowError(
    expect.objectContaining({ code: "controller-conflict" }),
  );
  expect(owner.controllerSnapshot().controllerClientId).toBe("command-center:owner");
  await owner.close();
  expect(viewer.requestAuthority("input")?.clientId).toBe("gpui:viewer");
  await viewer.close();
  await registry.dispose();
});
