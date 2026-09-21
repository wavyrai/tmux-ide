import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationHomeCatalogSnapshot } from "./application-home-catalog.ts";
const machine = vi.hoisted(() => ({ epoch: 0 }));
vi.mock("./application-daemon-authority.ts", async () => ({
  ...(await vi.importActual<typeof import("./application-daemon-authority.ts")>(
    "./application-daemon-authority.ts",
  )),
  applicationDaemonEndpoint: () => ({ epoch: machine.epoch, kind: "local" }),
}));
import { createApplicationHomeCatalogOwner } from "./application-home-catalog-owner.ts";
function rig(allowed: () => boolean) {
  let publish!: (snapshot: ApplicationHomeCatalogSnapshot) => void;
  let dispose!: () => void;
  const start = vi.fn();
  const initial: ApplicationHomeCatalogSnapshot = {
    phase: "loading",
    daemonInstanceId: null,
    sessions: [],
    note: null,
  };
  createRoot((cleanup) => {
    dispose = cleanup;
    return createApplicationHomeCatalogOwner({
      lifecycle: { registerCloser: () => () => {} },
      automaticOpen: true,
      automaticOpenAllowed: allowed,
      startGeneration: start,
      catalog: {
        getSnapshot: () => initial,
        subscribe: (listener) => {
          publish = listener;
          return () => {};
        },
        start: vi.fn(),
        retry: vi.fn(),
        dispose: vi.fn(),
      },
    });
  });
  return {
    start,
    dispose,
    publish: () =>
      publish({
        phase: "live",
        daemonInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sessions: [{ id: "first", name: "first", paneCount: 1 }],
        note: null,
      }),
  };
}
beforeEach(() => {
  machine.epoch = 0;
});
describe("one-session startup navigation admission", () => {
  it("preserves automatic opening for an untouched local-only startup", () => {
    const f = rig(() => true);
    f.publish();
    expect(f.start).toHaveBeenCalledExactlyOnceWith("first");
    f.dispose();
  });
  it("does not open a remote singleton if selected authority changes while local discovery waits", () => {
    const f = rig(() => true);
    machine.epoch++;
    f.publish();
    expect(f.start).not.toHaveBeenCalled();
    f.dispose();
  });
  it("permanently cancels automatic opening after explicit user navigation or Add machine", () => {
    let allowed = true;
    const f = rig(() => allowed);
    allowed = false;
    f.publish();
    allowed = true;
    f.publish();
    expect(f.start).not.toHaveBeenCalled();
    f.dispose();
  });
});
