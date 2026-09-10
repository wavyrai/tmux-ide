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
