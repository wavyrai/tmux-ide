import { saveSkill, deleteSkill, loadSkill } from "../../../lib/skill-registry.ts";
import { broadcastSkillsChanged as broadcastSkillsChangedDefault } from "../../ws-events.ts";
import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resolveProjectContext, type ProjectContextDeps } from "./_project-context.ts";

interface SkillActionDeps extends ProjectContextDeps {
  broadcastSkillsChanged?: (sessionName: string) => void;
}

function broadcast(sessionName: string, deps: SkillActionDeps): void {
  (deps.broadcastSkillsChanged ?? broadcastSkillsChangedDefault)(sessionName);
}

function skillError(err: unknown): ActionError {
  return new ActionError({
    code: "skill_invalid",
    message: (err as Error).message ?? String(err),
    cause: err,
  });
}

export function skillCreateHandler(
  input: ActionInput<"skill.create">,
  deps: SkillActionDeps = {},
): ActionResult<"skill.create"> {
  const context = resolveProjectContext(input, deps);
  try {
    const skill = saveSkill(context.dir, input.name, input.content);
    broadcast(context.sessionName, deps);
    return { skill };
  } catch (err) {
    throw skillError(err);
  }
}

export function skillUpdateHandler(
  input: ActionInput<"skill.update">,
  deps: SkillActionDeps = {},
): ActionResult<"skill.update"> {
  const context = resolveProjectContext(input, deps);
  if (!loadSkill(context.dir, input.name)) {
    throw new ActionError({
      code: "skill_not_found",
      message: `Skill "${input.name}" not found`,
      details: { name: input.name },
    });
  }
  try {
    const skill = saveSkill(context.dir, input.name, input.content);
    broadcast(context.sessionName, deps);
    return { skill };
  } catch (err) {
    throw skillError(err);
  }
}

export function skillDeleteHandler(
  input: ActionInput<"skill.delete">,
  deps: SkillActionDeps = {},
): ActionResult<"skill.delete"> {
  const context = resolveProjectContext(input, deps);
  const deleted = deleteSkill(context.dir, input.name);
  if (!deleted) {
    throw new ActionError({
      code: "skill_not_found",
      message: `Skill "${input.name}" not found`,
      details: { name: input.name },
    });
  }
  broadcast(context.sessionName, deps);
  return { deleted: true };
}
