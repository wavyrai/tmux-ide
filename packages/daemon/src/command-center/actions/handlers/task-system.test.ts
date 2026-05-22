import { describe, it, expect } from "bun:test";
import { saveMission, saveTask } from "../../../lib/task-store.ts";
import {
  goalCreateHandler,
  goalDeleteHandler,
  goalDoneHandler,
  goalUpdateHandler,
  milestoneCreateHandler,
  milestoneUpdateHandler,
  missionClearHandler,
  missionPlanCompleteHandler,
  missionSetHandler,
  taskClaimHandler,
  taskCreateHandler,
  taskDeleteHandler,
  taskDoneHandler,
  taskUpdateHandler,
} from "./task-system.ts";
import { TestProject, makeMission, makeTask, makeGoal } from "../../../__tests__/support.ts";

function withProject<T>(fn: (project: TestProject) => T): T {
  const project = new TestProject();
  try {
    project.initTasks();
    return fn(project);
  } finally {
    project.cleanup();
  }
}

describe("task action handlers", () => {
  it("task.create creates a task", () =>
    withProject((project) => {
      const result = taskCreateHandler(
        { title: "Ship it", goalId: "01", priority: 1, tags: ["ui"] },
        { dir: project.dir },
      );
      expect(result.taskId).toBe("001");
      expect(result.task.title).toBe("Ship it");
      expect(result.task.goal).toBe("01");
      expect(result.task.tags).toEqual(["ui"]);
    }));

  it("task.update edits an existing task and rejects missing ids", () =>
    withProject((project) => {
      project.addTask({ id: "001", title: "Before" });
      const result = taskUpdateHandler(
        { taskId: "001", title: "After", status: "review", proof: "checked" },
        { dir: project.dir },
      );
      expect(result.task.title).toBe("After");
      expect(result.task.status).toBe("review");
      expect(result.task.proof?.notes).toBe("checked");
      expect(() => taskUpdateHandler({ taskId: "404" }, { dir: project.dir })).toThrow(/not found/);
    }));

  it("task.claim claims unblocked tasks and reports blocked tasks", () =>
    withProject((project) => {
      project.addTask({ id: "001", depends_on: ["000"] });
      project.addTask({ id: "000", status: "todo" });
      expect(() =>
        taskClaimHandler({ taskId: "001", assign: "Agent" }, { dir: project.dir }),
      ).toThrow(/unmet dependencies/);

      saveTask(project.dir, makeTask({ id: "000", status: "done" }));
      const result = taskClaimHandler({ taskId: "001", assign: "Agent" }, { dir: project.dir });
      expect(result.task.assignee).toBe("Agent");
      expect(result.task.status).toBe("in-progress");
    }));

  it("task.done marks a task done and task.delete removes one", () =>
    withProject((project) => {
      project.addTask({ id: "001" });
      expect(
        taskDoneHandler({ taskId: "001", proof: { notes: "done" } }, { dir: project.dir }).task
          .status,
      ).toBe("done");
      expect(taskDeleteHandler({ taskId: "001" }, { dir: project.dir })).toEqual({
        deleted: true,
      });
      expect(() => taskDeleteHandler({ taskId: "001" }, { dir: project.dir })).toThrow(/not found/);
    }));
});

describe("goal action handlers", () => {
  it("goal.create creates a goal", () =>
    withProject((project) => {
      const result = goalCreateHandler(
        { title: "Goal", priority: 1, acceptance: "Done" },
        { dir: project.dir },
      );
      expect(result.goalId).toBe("01");
      expect(result.goal.acceptance).toBe("Done");
    }));

  it("goal.update and goal.done update existing goals", () =>
    withProject((project) => {
      project.addGoal(makeGoal({ id: "01", title: "Before" }));
      expect(
        goalUpdateHandler({ goalId: "01", title: "After" }, { dir: project.dir }).goal.title,
      ).toBe("After");
      expect(goalDoneHandler({ goalId: "01" }, { dir: project.dir }).goal.status).toBe("done");
      expect(() => goalUpdateHandler({ goalId: "99" }, { dir: project.dir })).toThrow(/not found/);
    }));

  it("goal.delete deletes existing goals and errors for missing goals", () =>
    withProject((project) => {
      project.addGoal(makeGoal({ id: "01" }));
      expect(goalDeleteHandler({ goalId: "01" }, { dir: project.dir })).toEqual({
        deleted: true,
      });
      expect(() => goalDeleteHandler({ goalId: "01" }, { dir: project.dir })).toThrow(/not found/);
    }));
});

describe("milestone and mission action handlers", () => {
  it("mission.set creates an active mission and mission.clear removes it", () =>
    withProject((project) => {
      const set = missionSetHandler(
        { title: "Mission", description: "Details" },
        { dir: project.dir },
      );
      expect(set.mission.status).toBe("active");
      expect(missionClearHandler({}, { dir: project.dir })).toEqual({ cleared: true });
    }));

  it("mission.planComplete activates the first milestone", () =>
    withProject((project) => {
      saveMission(
        project.dir,
        makeMission({
          status: "planning",
          milestones: [
            {
              id: "M1",
              title: "One",
              description: "",
              status: "locked",
              order: 1,
              created: "2026-01-01T00:00:00Z",
              updated: "2026-01-01T00:00:00Z",
            },
            {
              id: "M2",
              title: "Two",
              description: "",
              status: "active",
              order: 2,
              created: "2026-01-01T00:00:00Z",
              updated: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      );
      const result = missionPlanCompleteHandler({}, { dir: project.dir });
      expect(result.mission.status).toBe("active");
      expect(result.mission.milestones[0]?.status).toBe("active");
      expect(result.mission.milestones[1]?.status).toBe("locked");
    }));

  it("milestone.create and milestone.update mutate mission milestones", () =>
    withProject((project) => {
      saveMission(project.dir, makeMission({ milestones: [] }));
      const created = milestoneCreateHandler({ title: "M one", sequence: 1 }, { dir: project.dir });
      expect(created.milestoneId).toBe("M1");
      const updated = milestoneUpdateHandler(
        { milestoneId: "M1", status: "validating" },
        { dir: project.dir },
      );
      expect(updated.milestone.status).toBe("validating");
      expect(() =>
        milestoneUpdateHandler({ milestoneId: "M9", status: "done" }, { dir: project.dir }),
      ).toThrow(/not found/);
    }));

  it("milestone.create errors when no mission exists", () =>
    withProject((project) => {
      missionClearHandler({}, { dir: project.dir });
      expect(() => milestoneCreateHandler({ title: "Nope" }, { dir: project.dir })).toThrow(
        /No mission set/,
      );
    }));
});
