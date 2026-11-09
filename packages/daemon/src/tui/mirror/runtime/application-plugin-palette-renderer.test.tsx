/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { KeyboardRouteProvider, createKeyboardRouteOwner } from "../ui/keyboard-router.tsx";
import { MinimalPalette } from "./application-shell-overlays.tsx";

it("F5 palette shows plugin commands and a plugin form step", async () => {
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
              kind: "plugin-command",
              id: "plugin.tasks.new",
              label: "New task",
              category: "Tasks",
              plugin: "tasks",
              dangerous: false,
              params: [
                {
                  name: "name",
                  type: "string",
                  label: "Branch name",
                  required: true,
                  dynamicDefault: false,
                  dynamicChoices: false,
                },
              ],
            },
            {
              kind: "plugin-form",
              key: "submit",
              label: "Use “fix-login”",
              detail: "Branch name",
            },
          ]}
          keyboardHint="New task · Branch name (1/1) · Enter to choose · Esc to cancel"
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
    expect(frame).toContain("New task…");
    expect(frame).toMatch(/^\s+Tasks\s*$/mu);
    expect(frame).toMatch(/^\s+Choose\s*$/mu);
    expect(frame).toContain("Use “fix-login”");
    expect(frame).toContain("Branch name (1/1)");
  } finally {
    setup.renderer.destroy();
    owner.dispose();
  }
});
