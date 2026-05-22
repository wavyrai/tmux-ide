import { basename } from "node:path";
import { getSessionName } from "../../../lib/yaml-io.ts";
import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";

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

export function resolveProjectContext(
  input: ProjectContextInput,
  deps: ProjectContextDeps = {},
): ProjectContext {
  if (input.projectName) {
    const project = resolveProject(input.projectName, deps);
    return { dir: project.dir, sessionName: project.sessionName };
  }

  const dir = deps.cwd ?? process.cwd();
  const sessionName = getSessionName(dir).name || basename(dir);
  return { dir, sessionName };
}
