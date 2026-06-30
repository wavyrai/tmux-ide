import { activateProject as activateProjectDefault } from "../../../lib/active-projects.ts";
import type { ProjectActivationOptions } from "../../../lib/active-projects.ts";
import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";

export interface ProjectActivateDeps extends ProjectResolverDeps {
  activateProject?: (name: string, options?: ProjectActivationOptions) => Promise<void>;
}

export async function projectActivateHandler(
  input: ActionInput<"project.activate">,
  deps: ProjectActivateDeps = {},
): Promise<ActionResult<"project.activate">> {
  const project = resolveProject(input.name, deps);
  const activateProject = deps.activateProject ?? activateProjectDefault;

  try {
    await activateProject(project.name);
  } catch (err) {
    throw new ActionError({
      code: "internal",
      message: `Failed to activate project "${project.name}": ${(err as Error).message ?? String(err)}`,
      details: { projectName: project.name },
      cause: err,
    });
  }

  return { active: true, projectName: project.name };
}
