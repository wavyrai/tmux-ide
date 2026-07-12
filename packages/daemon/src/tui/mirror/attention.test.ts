/**
 * Unit tests for the in-app attention model — the per-pane diff, the
 * visibility test, and the note formatting.
 */
import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../detect/classify.ts";
import {
  attentionNote,
  attentionNoteLine,
  diffAttention,
  isPaneVisible,
  noteworthyTransitions,
  type AttentionAgent,
  type AttentionTransition,
} from "./attention.ts";

const agent = (paneId: string, state: AgentStatus, session = "api"): AttentionAgent => ({
  paneId,
  session,
  kind: "claude",
  state,
});

const t = (over: Partial<AttentionTransition> = {}): AttentionTransition => ({
  paneId: "%1",
  session: "api",
  kind: "claude",
  from: "working",
  to: "blocked",
  ...over,
});

describe("diffAttention", () => {
  it("emits transitions for changed panes and first-sight (from null) for new ones", () => {
    const prev = new Map<string, AgentStatus>([["%1", "working"]]);
    const { transitions, next } = diffAttention(prev, [
      agent("%1", "blocked"),
      agent("%2", "working"),
    ]);
    expect(transitions).toEqual([
      { paneId: "%1", session: "api", kind: "claude", from: "working", to: "blocked" },
      { paneId: "%2", session: "api", kind: "claude", from: null, to: "working" },
    ]);
    expect(next.get("%1")).toBe("blocked");
    // The input map is untouched (app.tsx swaps in `next` itself).
    expect(prev.get("%1")).toBe("working");
  });

  it("emits nothing for unchanged panes and drops vanished ones from the state", () => {
    const prev = new Map<string, AgentStatus>([
      ["%1", "working"],
      ["%9", "blocked"],
    ]);
    const { transitions, next } = diffAttention(prev, [agent("%1", "working")]);
    expect(transitions).toEqual([]);
    expect(next.has("%9")).toBe(false);
  });

  it("dedupes a pane surfacing under two projects", () => {
    const { transitions } = diffAttention(new Map([["%1", "working"]]), [
      agent("%1", "blocked"),
      agent("%1", "blocked"),
    ]);
    expect(transitions).toHaveLength(1);
  });
});

describe("isPaneVisible / noteworthyTransitions", () => {
  it("only Terminal-tab panes of the mirrored window are visible", () => {
    expect(isPaneVisible("%1", { tab: "terminal", visiblePaneIds: ["%1", "%2"] })).toBe(true);
    expect(isPaneVisible("%3", { tab: "terminal", visiblePaneIds: ["%1", "%2"] })).toBe(false);
    expect(isPaneVisible("%1", { tab: "files", visiblePaneIds: ["%1"] })).toBe(false);
    expect(isPaneVisible("%1", { tab: "home", visiblePaneIds: [] })).toBe(false);
  });

  it("notes blocked/done for hidden panes only; first-sight and working never note", () => {
    const view = { tab: "terminal", visiblePaneIds: ["%1"] };
    const worthy = noteworthyTransitions(
      [
        t({ paneId: "%1" }), // visible — suppressed
        t({ paneId: "%2" }), // hidden blocked — notes
        t({ paneId: "%3", to: "done" }), // hidden done — notes
        t({ paneId: "%4", from: null }), // first sight — graced
        t({ paneId: "%5", to: "working" }), // not a notify state
      ],
      view,
    );
    expect(worthy.map((w) => w.paneId)).toEqual(["%2", "%3"]);
  });

  it("a non-Terminal tab makes every transition noteworthy (nothing is visible)", () => {
    const worthy = noteworthyTransitions([t({ paneId: "%1" })], {
      tab: "diff",
      visiblePaneIds: ["%1"],
    });
    expect(worthy).toHaveLength(1);
  });
});

describe("attentionNote / attentionNoteLine", () => {
  it("formats the card's example shape, with ✓ for done", () => {
    expect(attentionNote(t({ session: "zz-api" }))).toBe(
      "● claude blocked · zz-api — click agents",
    );
    expect(attentionNote(t({ to: "done" }))).toBe("✓ claude done · api — click agents");
  });

  it("collapses a multi-agent poll into one line with a (+N) tail", () => {
    expect(attentionNoteLine([])).toBeNull();
    expect(attentionNoteLine([t()])).toBe("● claude blocked · api — click agents");
    expect(attentionNoteLine([t(), t({ paneId: "%2" }), t({ paneId: "%3" })])).toBe(
      "● claude blocked · api — click agents (+2)",
    );
  });
});
