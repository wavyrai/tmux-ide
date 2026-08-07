/* @vitest-environment happy-dom */
import {
  DesktopMissionWorkspaceResourceSchemaZ,
  type DesktopMissionWorkspaceResource,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { createMissionActivityFixture } from "./mission-activity-fixture.ts";
import { MissionActivitySurface } from "./mission-activity-surface.tsx";

function mountSurface(mode: "missions" | "activity" = "missions") {
  const root = document.createElement("div");
  document.body.append(root);
  const [selectedMissionId, setSelectedMissionId] = createSignal<string | null>(null);
  const [selectedActivityId, setSelectedActivityId] = createSignal<string | null>(null);
  const onSelectMission = vi.fn((id: string) => setSelectedMissionId(id));
  const onSelectActivity = vi.fn((id: string) => setSelectedActivityId(id));
  const onOpenMissions = vi.fn();
  const onOpenActivity = vi.fn();
  const onOpenTerminals = vi.fn();
  const onRefresh = vi.fn();
  const dispose = render(
    () => (
      <MissionActivitySurface
        mode={mode}
        resource={createMissionActivityFixture()}
        selectedMissionId={selectedMissionId()}
        selectedActivityId={selectedActivityId()}
        onSelectMission={onSelectMission}
        onSelectActivity={onSelectActivity}
        onOpenMissions={onOpenMissions}
        onOpenActivity={onOpenActivity}
        onOpenTerminals={onOpenTerminals}
        onRefresh={onRefresh}
      />
    ),
    root,
  );
  return {
    root,
    dispose,
    onSelectMission,
    onSelectActivity,
    onOpenMissions,
    onOpenActivity,
    onOpenTerminals,
    onRefresh,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("desktop mission and activity journey", () => {
  it("renders mission status, proof, progress, and a next semantic action without style attributes", () => {
    const harness = mountSurface();
    expect(harness.root.textContent).toContain("Desktop parity");
    expect(harness.root.textContent).toContain("12/12 tests passing");
    expect(harness.root.textContent).toContain("6 files");
    expect(harness.root.textContent).toContain("Follow activity");
    expect(harness.root.textContent).toContain("Timeline");
    expect(harness.root.textContent).toContain("Latest attempt");
    expect(harness.root.querySelector("progress")?.getAttribute("value")).toBe("50");
    expect(harness.root.querySelector("[style]")).toBeNull();

    [...harness.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Follow activity"))
      ?.click();
    expect(harness.onOpenActivity).toHaveBeenCalledWith("mis_alpha");

    [...harness.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Return to terminals"))
      ?.click();
    expect(harness.onOpenTerminals).toHaveBeenCalledOnce();
    harness.dispose();
  });

  it("keeps focus, semantic selection, aria-selected, and detail in sync for keyboard navigation", async () => {
    const harness = mountSurface();
    const options = harness.root.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options[0]?.focus();
    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement).toBe(options[1]);
    expect(harness.onSelectMission).toHaveBeenLastCalledWith("mis_beta");
    await vi.waitFor(() => expect(options[1]?.getAttribute("aria-selected")).toBe("true"));
    expect(harness.root.querySelector(".mission-journey__detail h3")?.textContent).toBe(
      "Onboarding proof",
    );

    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(harness.onSelectMission).toHaveBeenLastCalledWith("mis_beta");
    harness.dispose();
  });

  it("moves from durable activity to the correlated mission through one obvious action", () => {
    const harness = mountSurface("activity");
    expect(harness.root.textContent).toContain("Proof recorded");
    expect(harness.root.textContent).toContain("Renderer acceptance passed.");
    expect(harness.root.textContent).toContain("2 proof records · 12/12 tests");
    expect(harness.root.textContent).toContain("Recent activity");
    expect(harness.root.textContent).toContain("Mission entered review");

    [...harness.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Inspect mission"))
      ?.click();
    expect(harness.onOpenMissions).toHaveBeenCalledWith("mis_alpha");
    harness.dispose();
  });

  it("shows the durable outcome and attempt summary for mission history", async () => {
    const harness = mountSurface();
    const options = harness.root.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options[2]?.focus();

    await vi.waitFor(() =>
      expect(harness.root.querySelector(".mission-journey__history")?.textContent).toContain(
        "completed",
      ),
    );
    expect(harness.root.textContent).toContain("2 attempts · 2 approved · 0 failed");
    expect(harness.root.textContent).toContain("Mission completed with proof");
    harness.dispose();
  });

  it("keeps empty and degraded states honest with bounded recovery actions", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const refresh = vi.fn();
    const terminals = vi.fn();
    const common = {
      mode: "missions" as const,
      selectedMissionId: null,
      selectedActivityId: null,
      onSelectMission: vi.fn(),
      onSelectActivity: vi.fn(),
      onOpenMissions: vi.fn(),
      onOpenActivity: vi.fn(),
      onOpenTerminals: terminals,
      onRefresh: refresh,
    };
    const [resource, setResource] = createSignal<DesktopMissionWorkspaceResource>(
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "degraded",
        reason: "Mission history could not be verified.",
      }),
    );
    const dispose = render(
      () => <MissionActivitySurface {...common} resource={resource()} />,
      root,
    );
    expect(root.textContent).toContain("terminal workspace remains available");
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Retry mission history"))
      ?.click();
    expect(refresh).toHaveBeenCalledOnce();

    setResource(
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "empty",
        counts: { missions: 0, history: 0, activity: 0 },
        missions: [],
        history: [],
        activity: [],
        truncated: false,
      }),
    );
    expect(root.textContent).toContain("No missions recorded yet");
    expect(root.textContent).toContain("No configuration file is required");
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Open terminals"))
      ?.click();
    expect(terminals).toHaveBeenCalledOnce();
    dispose();
  });

  it("uses instance-safe detail heading ids", () => {
    const first = mountSurface("missions");
    const second = mountSurface("activity");
    const labels = [...document.querySelectorAll<HTMLElement>(".mission-journey__detail")].map(
      (element) => element.getAttribute("aria-labelledby"),
    );
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(document.getElementById(label!)).not.toBeNull();
    first.dispose();
    second.dispose();
  });
});
