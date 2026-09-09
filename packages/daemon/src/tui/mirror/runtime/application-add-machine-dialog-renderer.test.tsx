/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { ApplicationAddMachineDialog } from "./application-add-machine-dialog.tsx";

describe("Add machine dialog", () => {
  it("accepts an SSH target through the focused field and submits without owning connection state", async () => {
    const [alias, setAlias] = createSignal("");
    const submissions: string[] = [];
    const setup = await renderForTest(
      () => (
        <ApplicationAddMachineDialog
          open={true}
          alias={alias()}
          onAliasChange={setAlias}
          onSubmit={() => submissions.push(alias())}
          onCancel={() => {}}
          error={null}
          width={70}
          height={20}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
        />
      ),
      { width: 70, height: 20 },
    );
    await setup.renderOnce();
    await setup.mockInput.pressEnter();
    expect(submissions).toEqual([]);
    await setup.mockInput.typeText("user@server");
    await setup.renderOnce();
    expect(alias()).toBe("user@server");
    expect(setup.captureCharFrame()).toContain("SSH alias or user@host");
    await setup.mockInput.pressEnter();
    expect(submissions).toEqual(["user@server"]);
    setup.renderer.destroy();
  });
});
