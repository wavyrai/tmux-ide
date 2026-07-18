import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";
import { resolveProjectConfigContext } from "../../../lib/config-context.ts";

export interface ProjectContextDeps extends ProjectResolverDeps {
  cwd?: string;
}

export interface ProjectContextInput {
  projectName?: string;
}

export interface ProjectContext {
  dir: string;
  sessionName: string;
}

export async function resolveProjectContext(
  input: ProjectContextInput,
  deps: ProjectContextDeps = {},
): Promise<ProjectContext> {
  if (input.projectName) {
    const project = resolveProject(input.projectName, deps);
    return { dir: project.dir, sessionName: project.sessionName };
  }

  const dir = deps.cwd ?? process.cwd();
  const { sessionName } = await resolveProjectConfigContext(dir);
  return { dir, sessionName };
}
