/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { KeyboardRouteProvider, createKeyboardRouteOwner } from "../ui/keyboard-router.tsx";
import { ApplicationPalettePreview } from "./application-palette-preview.tsx";

it("shows exact unavailable host without falling back and owns only its preview chords", async () => {
  const [active, setActive] = createSignal(true);
  const expanded: boolean[] = [];
  const owner = createKeyboardRouteOwner();
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <ApplicationPalettePreview
          command={{
            kind: "open-session",
            sessionName: "api",
            label: "api",
            fleet: {
              machineId: "missing-preview-host",
              liveSessionId: "live-session.12345678901234567890",
              hostLabel: "GPU host",
              daemonInstanceId: "11111111-1111-4111-8111-111111111111",
            },
          }}
          width={50}
          height={10}
          active={active()}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          onExpandedChange={(value) => expanded.push(value)}
        />
      </KeyboardRouteProvider>
    ),
    { width: 50, height: 10 },
  );
  const key = (name: string, ctrl = true) =>
    owner.route({
      name,
      eventType: "press",
      ctrl,
      meta: false,
      shift: false,
      preventDefault() {},
      stopPropagation() {},
    });
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("GPU host · api");
    expect(setup.captureCharFrame()).toContain("Preview unavailable");
    expect(key("p", false)).toBe(false);
    expect(key("e")).toBe(true);
    expect(expanded).toEqual([true]);
    key("p");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Preview hidden");
    expect(expanded).toEqual([true, false]);
    key("p");
    setActive(false);
    await setup.renderOnce();
    expect(key("e")).toBe(false);
  } finally {
    setup.renderer.destroy();
    owner.dispose();
  }
});

it("changing agents in the same session changes the captured pane and cache identity", async () => {
  const { spyOn } = await import("bun:test");
  const { applicationMachineAuthorityManager: manager } =
    await import("./application-machine-authority.ts");
  const daemon = {
    bindHostname: "127.0.0.1",
    port: 4000,
    authToken: "fixture",
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: "fixture",
  };
  const authority = spyOn(manager, "getMachine").mockReturnValue({
    read: () => daemon,
    endpoint: () => ({ state: "ready", epoch: 999 }),
  } as any);
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push(body.paneId);
    return Response.json({
      daemon,
      liveSessionId: body.liveSessionId,
      selectedPaneId: body.paneId,
      selectedWindowId: "@1",
      windows: [{ id: "@1", index: 0, name: "main", active: true, paneIds: ["%1", "%2"] }],
      text: body.paneId === "%1" ? "FIRST AGENT CONTENT" : "SECOND AGENT CONTENT",
    });
  }) as typeof fetch;
  const [pane, setPane] = createSignal("%1");
  const owner = createKeyboardRouteOwner();
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <ApplicationPalettePreview
          command={{
            kind: "jump-agent",
            paneId: pane(),
            label: pane(),
            sessionName: "same session",
            fleet: {
              machineId: "pane-preview-fixture",
              hostLabel: "Mini",
              liveSessionId: "live-session.12345678901234567890",
              daemonInstanceId: daemon.instanceId,
            },
          }}
          width={60}
          height={12}
          active={true}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
        />
      </KeyboardRouteProvider>
    ),
    { width: 60, height: 12 },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("FIRST AGENT CONTENT");
    setPane("%2");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("FIRST AGENT CONTENT");
    await new Promise((resolve) => setTimeout(resolve, 220));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("SECOND AGENT CONTENT");
    setPane("%1");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("FIRST AGENT CONTENT");
    expect(requests).toEqual(["%1", "%2"]);
  } finally {
    setup.renderer.destroy();
    owner.dispose();
    authority.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
