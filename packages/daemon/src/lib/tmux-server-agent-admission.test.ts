import { describe, expect, it } from "vitest";
import { captureAgentAdmission } from "./tmux-server-agent-admission.ts";
import {
  fallbackPaneId,
  agentIdForPaneStamp,
} from "../command-center/resources/application-shell.ts";
const session = { id: "$1", name: "ordinary" };
const pane = fallbackPaneId(
  { name: session.name, runtimeSessionId: session.id },
  { runtimePaneId: "%2" },
);
const observed = { observedPaneId: pane, observedAgentId: agentIdForPaneStamp(pane) };
describe("targeted agent admission", () => {
  it("maps only the captured native lifetime through promotion", async () => {
    let rows = "$1\t@1\t%2\t12\t\n$1\t@1\t%3\t13\t";
    const admission = await captureAgentAdmission(async () => rows, session, observed);
    await admission.verify(false);
    rows = "$1\t@1\t%2\t12\tpane.promoted.original\n$1\t@1\t%3\t13\tpane.promoted.other";
    expect(await admission.verify(true)).toBe("pane.promoted.original");
  });
  for (const replacement of [
    "$1\t@1\t%2\t14\tpane.new",
    "$1\t@2\t%2\t12\tpane.new",
    "$1\t@1\t%3\t13\tpane.new",
    "$2\t@1\t%2\t12\tpane.new",
    "$1\t@1\t%2\t12\tpane.same\n$1\t@1\t%3\t13\tpane.same",
  ]) {
    it(`refuses changed or ambiguous native binding ${replacement}`, async () => {
      let rows = "$1\t@1\t%2\t12\t";
      const admission = await captureAgentAdmission(async () => rows, session, observed);
      rows = replacement;
      await expect(admission.verify(true)).rejects.toThrow();
    });
  }
  describe("on a stock tmux server, which has no pane birth id (#736)", () => {
    it("maps the captured pane through promotion", async () => {
      let rows = "$1\t@1\t%2\t\t\n$1\t@1\t%3\t\t";
      const admission = await captureAgentAdmission(async () => rows, session, observed);
      await admission.verify(false);
      rows = "$1\t@1\t%2\t\tpane.promoted.original\n$1\t@1\t%3\t\tpane.promoted.other";
      expect(await admission.verify(true)).toBe("pane.promoted.original");
    });
    for (const replacement of [
      "$1\t@2\t%2\t\tpane.new",
      "$1\t@1\t%3\t\tpane.new",
      "$2\t@1\t%2\t\tpane.new",
      "$1\t@1\t%2\t\tpane.same\n$1\t@1\t%3\t\tpane.same",
      // A birth id that appears later means another server answered.
      "$1\t@1\t%2\t12\tpane.new",
    ]) {
      it(`refuses changed or ambiguous binding ${replacement}`, async () => {
        let rows = "$1\t@1\t%2\t\t";
        const admission = await captureAgentAdmission(async () => rows, session, observed);
        rows = replacement;
        await expect(admission.verify(true)).rejects.toThrow();
      });
    }
    it("refuses a server that reports a birth id for some panes only", async () => {
      await expect(
        captureAgentAdmission(async () => "$1\t@1\t%2\t\t\n$1\t@1\t%3\t13\t", session, observed),
      ).rejects.toThrow("Agent native identity is unavailable");
    });
  });
  it.each(["abc", "0", "12x", "-1", " "])(
    "refuses a birth id that is not one: %j",
    async (birth) => {
      await expect(
        captureAgentAdmission(async () => `$1\t@1\t%2\t${birth}\t`, session, observed),
      ).rejects.toThrow("Agent native identity is unavailable");
    },
  );
  it("rejects mismatched agent identity before promotion", async () => {
    await expect(
      captureAgentAdmission(async () => "$1\t@1\t%2\t12\t", session, {
        ...observed,
        observedAgentId: "agent.other",
      }),
    ).rejects.toThrow();
  });
  it("refuses an already promoted pane whose stamp changes", async () => {
    let rows = "$1\t@1\t%2\t12\tpane.original";
    const admission = await captureAgentAdmission(async () => rows, session, {
      observedPaneId: "pane.original",
      observedAgentId: agentIdForPaneStamp("pane.original"),
    });
    rows = "$1\t@1\t%2\t12\tpane.other";
    await expect(admission.verify(true)).rejects.toThrow();
  });
});
