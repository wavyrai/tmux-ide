import { expect, it } from "vitest";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";

it("preserves input identity through screen recapture but retires it with the owner", async () => {
  let request!: MirrorSubscribeRequest;
  const incarnation = "00000000-0000-4000-8000-000000000001:0";
  const layout = (width: number) => ({
    type: "layout" as const,
    session: "workspace",
    semanticWindowId: "window-a",
    windowName: "main",
    currentWindow: true,
    cols: width,
    rows: 1,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [{ semanticPaneId: "pane-a", left: 0, top: 0, width, height: 1, active: true }],
  });
  const owner = new SessionRuntimeTerminalReplicaOwner(
    "00000000-0000-4000-8000-000000000001",
    "workspace",
    "pane-a",
    {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        return {
          session: candidate.session,
          semanticPaneId: candidate.semanticPaneId,
          freeze() {},
          thaw() {},
          reseed() {},
          sendText() {},
          sendKey() {},
          close: async () => {},
        };
      },
    } as never,
    { incarnation, initialRevision: 0 },
  );
  try {
    expect(owner.inputAdmissionIncarnation()).toBeNull();
    await Promise.resolve();
    request.onLayout?.(layout(4));
    request.onEvent({ type: "reset", cols: 4, rows: 1 });
    request.onEvent({ type: "seed", data: new TextEncoder().encode("BOOT") });
    request.onEvent({ type: "cursor", x: 0, y: 0 });
    await expect.poll(() => owner.inputAdmissionIncarnation()).toBe(incarnation);
    const before = owner.qualificationSnapshot().revision;
    request.onLayout?.(layout(6));
    expect(owner.inputAdmissionIncarnation()).toBe(incarnation);
    request.onEvent({ type: "reset", cols: 6, rows: 1 });
    expect(owner.inputAdmissionIncarnation()).toBe(incarnation);
    request.onEvent({ type: "seed", data: new TextEncoder().encode("RESIZE") });
    expect(owner.inputAdmissionIncarnation()).toBe(incarnation);
    request.onEvent({ type: "cursor", x: 0, y: 0 });
    await expect.poll(() => owner.qualificationSnapshot().revision).not.toBe(before);
    expect(owner.inputAdmissionIncarnation()).toBe(incarnation);
  } finally {
    await owner.dispose();
  }
  expect(owner.inputAdmissionIncarnation()).toBeNull();
});
