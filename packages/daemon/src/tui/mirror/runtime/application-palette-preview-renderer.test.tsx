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
