/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { MinimalPalette } from "./application-shell-overlays.tsx";
import { KeyboardRouteProvider, createKeyboardRouteOwner } from "../ui/keyboard-router.tsx";

it("actual F5 surface shows the selected remote preview and its controls", async () => {
  const owner = createKeyboardRouteOwner();
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <MinimalPalette
          width={100}
          height={30}
          selected={0}
          closeArmed={false}
          commands={[
            {
              kind: "open-session",
              sessionName: "api",
              label: "api",
              fleet: {
                machineId: "missing-host",
                hostLabel: "Mini",
                liveSessionId: "live-session.12345678901234567890",
                daemonInstanceId: "11111111-1111-4111-8111-111111111111",
              },
            },
          ]}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          onActivate={() => {}}
          onClose={() => {}}
          active={true}
        />
      </KeyboardRouteProvider>
    ),
    { width: 100, height: 30 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Command palette");
    expect(frame).toContain("Open session · api");
    expect(frame).toContain("Mini · api");
    expect(frame).toContain("Preview unavailable");
    expect(frame).toContain("Expand");
  } finally {
    setup.renderer.destroy();
    owner.dispose();
  }
});

it("keeps wide and narrow previews inside their surface and offers true full preview", async () => {
  const { writeFileSync } = await import("node:fs");
  for (const width of [60, 120, 160]) {
    const owner = createKeyboardRouteOwner();
    const setup = await renderForTest(
      () => (
        <KeyboardRouteProvider owner={owner}>
          <MinimalPalette
            width={width}
            height={36}
            selected={0}
            closeArmed={false}
            query="api"
            commands={[
              {
                kind: "open-session",
                sessionName: "api",
                label: "api",
                fleet: {
                  machineId: "missing-host",
                  hostLabel: "Mini",
                  liveSessionId: "live-session.12345678901234567890",
                  daemonInstanceId: "11111111-1111-4111-8111-111111111111",
                },
              },
            ]}
            theme={createSemanticThemeSnapshot({ mode: "dark" })}
            onActivate={() => {}}
            onClose={() => {}}
            active={true}
          />
        </KeyboardRouteProvider>
      ),
      { width, height: 36 },
    );
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      writeFileSync(`/tmp/beta18-palette-${width}.txt`, frame);
      expect(frame).toContain("Mini · api");
      expect(frame).toContain("Expand");
      expect(frame).toContain("1 matches");
      owner.route({
        name: "e",
        ctrl: true,
        meta: false,
        shift: false,
        eventType: "press",
        preventDefault() {},
        stopPropagation() {},
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Restore");
      expect(setup.captureCharFrame()).not.toContain("Open session · api");
    } finally {
      setup.renderer.destroy();
      owner.dispose();
    }
  }
});
