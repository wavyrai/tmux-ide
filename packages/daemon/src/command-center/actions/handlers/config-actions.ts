import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configAddPane,
  configAddRow,
  configDisableTeam,
  configEnableTeam,
  configRemovePane,
  configSetValue,
} from "../../../config.ts";
import { broadcastConfigChanged as broadcastConfigChangedDefault } from "../../ws-events.ts";
import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resolveProjectContext, type ProjectContextDeps } from "./_project-context.ts";

interface ConfigActionDeps extends ProjectContextDeps {
  broadcastConfigChanged?: (sessionName: string) => void;
}

function mutateConfigAction<Result>(
  input: { projectName?: string },
  deps: ConfigActionDeps,
  fn: (dir: string) => Result,
): Result {
  const context = resolveProjectContext(input, deps);
  if (!existsSync(join(context.dir, "ide.yml"))) {
    throw new ActionError({
      code: "ide_yml_missing",
      message: "ide.yml was not found",
      details: { dir: context.dir },
    });
  }
  try {
    const result = fn(context.dir);
    (deps.broadcastConfigChanged ?? broadcastConfigChangedDefault)(context.sessionName);
    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    throw new ActionError({
      code: message.toLowerCase().includes("path")
        ? "config_path_invalid"
        : "config_validation_failed",
      message,
      cause: err,
    });
  }
}

export function configSetHandler(
  input: ActionInput<"config.set">,
  deps: ConfigActionDeps = {},
): ActionResult<"config.set"> {
  const config = mutateConfigAction(input, deps, (dir) =>
    configSetValue(dir, input.path, input.value),
  );
  return { config };
}

export function configAddPaneHandler(
  input: ActionInput<"config.addPane">,
  deps: ConfigActionDeps = {},
): ActionResult<"config.addPane"> {
  const pane = {
    title: input.title,
    command: input.command,
    type: input.type,
    target: input.target,
    dir: input.dir,
    size: input.size,
    focus: input.focus,
    env: input.env,
    role: input.role,
    task: input.task,
    specialty: input.specialty,
    skill: input.skill,
  };
  const config = mutateConfigAction(input, deps, (dir) => configAddPane(dir, input.rowIndex, pane));
  return { config };
}

export function configRemovePaneHandler(
  input: ActionInput<"config.removePane">,
  deps: ConfigActionDeps = {},
): ActionResult<"config.removePane"> {
  const config = mutateConfigAction(input, deps, (dir) =>
    configRemovePane(dir, input.rowIndex, input.paneIndex),
  ).config;
  return { config };
}

export function configAddRowHandler(
  input: ActionInput<"config.addRow">,
  deps: ConfigActionDeps = {},
): ActionResult<"config.addRow"> {
  const config = mutateConfigAction(input, deps, (dir) => configAddRow(dir, input.size));
  return { config };
}

export function configEnableTeamHandler(
  input: ActionInput<"config.enableTeam">,
  deps: ConfigActionDeps = {},
): ActionResult<"config.enableTeam"> {
  const config = mutateConfigAction(input, deps, (dir) => configEnableTeam(dir, input.name));
  return { config };
}

export function configDisableTeamHandler(
  input: ActionInput<"config.disableTeam">,
  deps: ConfigActionDeps = {},
): ActionResult<"config.disableTeam"> {
  const config = mutateConfigAction(input, deps, (dir) => configDisableTeam(dir));
  return { config };
}
