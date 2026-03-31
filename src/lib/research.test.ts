import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMission, makeOrchestratorConfig, makeOrchestratorState, makePane, makeTask } from "../__tests__/support.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { saveMission, loadTasks, ensureTasksDir } from "./task-store.ts";
import {
  buildResearchPrompt,
  dispatchResearch,
  evaluateTriggers,
  loadResearchState,
  type ResearchState,
} from "./research.ts";

let tmpDir: string;
let restoreTmux: () => void;
let tmuxCalls: { args: string[] }[];
let mockPanes: PaneInfo[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-research-test-"));
  ensureTasksDir(tmpDir);
  tmuxCalls = [];
  mockPanes = [];
  restoreTmux = _setExecutor((_cmd: string, args: string[]) => {
    tmuxCalls.push({ args });
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (pane) =>
            `${pane.id}\t${pane.index}\t${pane.title}\t${pane.currentCommand}\t${pane.width}\t${pane.height}\t${pane.active ? "1" : "0"}\t${pane.role ?? ""}\t${pane.name ?? ""}\t${pane.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });
});

afterEach(() => {
  restoreTmux();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeResearchState(overrides: Partial<ResearchState> = {}): ResearchState {
  return {
    lastResearchAt: {},
    missionStartAnalyzed: false,
    milestoneTaskCounts: {},
    activeResearchTaskId: null,
    retryWindow: [],
    ...overrides,
  };
}

describe("evaluateTriggers", () => {
  it("fires mission_start only once", () => {
    saveMission(tmpDir, makeMission({ status: "active" }));
    const config = {
      ...makeOrchestratorConfig(tmpDir, { dispatchMode: "missions" }),
      research: { enabled: true, triggers: { mission_start: true } },
    };
    const state = makeOrchestratorState();
    const researchState = makeResearchState();

    const first = evaluateTriggers(config, state, researchState, [], []);
    const second = evaluateTriggers(config, state, researchState, [], []);

    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("mission_start");
    expect(second).toEqual([]);
  });

  it("fires milestone_progress after N completed tasks", () => {
    saveMission(
      tmpDir,
      makeMission({
        milestones: [
          {
            id: "M1",
            title: "Phase 1",
            description: "",
            status: "active",
            order: 1,
            created: "2026-01-01T00:00:00Z",
            updated: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const config = {
      ...makeOrchestratorConfig(tmpDir, { dispatchMode: "missions" }),
      research: { enabled: true, triggers: { milestone_progress: 2 } },
    };
    const state = makeOrchestratorState();
    const researchState = makeResearchState({ milestoneTaskCounts: { M1: 1 } });
    const tasks = [
      makeTask({ id: "001", milestone: "M1", status: "done" }),
      makeTask({ id: "002", milestone: "M1", status: "done" }),
    ];

    const triggers = evaluateTriggers(config, state, researchState, tasks, []);

    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.type).toBe("milestone_progress");
    expect(researchState.milestoneTaskCounts.M1).toBe(2);
  });

  it("respects periodic cooldowns", () => {
    const config = {
      ...makeOrchestratorConfig(tmpDir, { dispatchMode: "missions" }),
      research: { enabled: true, triggers: { periodic_minutes: 10 } },
    };
    const state = makeOrchestratorState();
    const researchState = makeResearchState({
      lastResearchAt: { periodic: new Date().toISOString() },
    });

    const triggers = evaluateTriggers(config, state, researchState, [], []);
    expect(triggers).toEqual([]);
  });

  it("skips triggers when a research agent is already busy", () => {
    saveMission(tmpDir, makeMission({ status: "active" }));
    const config = {
      ...makeOrchestratorConfig(tmpDir, { dispatchMode: "missions" }),
      research: { enabled: true, triggers: { mission_start: true } },
    };
    const state = makeOrchestratorState();
    const researchState = makeResearchState({ activeResearchTaskId: "099" });

    const triggers = evaluateTriggers(config, state, researchState, [], []);
    expect(triggers).toEqual([]);
  });
});

describe("buildResearchPrompt", () => {
  it("includes mission context", () => {
    saveMission(tmpDir, makeMission({ title: "Ship Droid Missions", description: "Audit the mission system" }));

    const prompt = buildResearchPrompt(tmpDir, "mission_start", {
      taskId: "099",
      reason: "Mission just started",
    });

    expect(prompt).toContain("Mission: Ship Droid Missions");
    expect(prompt).toContain("Audit the mission system");
    expect(prompt).toContain("tmux-ide task done 099");
  });
});

describe("dispatchResearch", () => {
  it("dispatches when a researcher pane is available", () => {
    saveMission(tmpDir, makeMission({ status: "active" }));
    const config = {
      ...makeOrchestratorConfig(tmpDir, { dispatchMode: "missions", maxConcurrentAgents: 4 }),
      research: { enabled: true, triggers: { mission_start: true } },
    };
    const state = makeOrchestratorState();
    const researchState = makeResearchState();
    const pane = makePane({ id: "%2", index: 1, title: "Researcher", role: "researcher", currentCommand: "zsh" });
    mockPanes = [pane];

    const task = dispatchResearch(config, state, researchState, [], [pane], {
      type: "mission_start",
      reason: "Mission started",
    });

    expect(task).not.toBeNull();
    expect(task?.tags).toEqual(["research", "mission_start"]);
    expect(task?.specialty).toBe("researcher");
    expect(researchState.activeResearchTaskId).toBe(task?.id ?? null);
    expect(existsSync(join(tmpDir, ".tasks", "dispatch", `research-${task?.id}.md`))).toBe(true);
    expect(loadTasks(tmpDir).some((saved) => saved.id === task?.id)).toBe(true);
    expect(tmuxCalls.some((call) => call.args.includes("send-keys"))).toBe(true);
  });

  it("does not dispatch without a researcher or fallback pane", () => {
    const config = {
      ...makeOrchestratorConfig(tmpDir, { dispatchMode: "missions", maxConcurrentAgents: 4 }),
      research: { enabled: true, triggers: { periodic_minutes: 1 } },
    };
    const state = makeOrchestratorState();
    const researchState = loadResearchState(tmpDir);

    const task = dispatchResearch(config, state, researchState, [], [], {
      type: "periodic",
      reason: "Periodic interval elapsed",
    });

    expect(task).toBeNull();
  });
});
