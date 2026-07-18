import {
  configAddPane,
  configAddRow,
  configDisableTeam,
  configEnableTeam,
  configRemovePane,
  configSetValue,
} from "../../../config.ts";
import { broadcastConfigChanged as broadcastConfigChangedDefault } from "../../ws-events.ts";
import { ActionError, type ActionErrorCode } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resolveProjectContext, type ProjectContextDeps } from "./_project-context.ts";
import {
  UnsupportedLegacyConfigMutationError,
  WorkspaceConfigWriteError,
} from "../../../lib/resolved-config.ts";
import { resolveProjectConfigContext } from "../../../lib/config-context.ts";

interface ConfigActionDeps extends ProjectContextDeps {
  broadcastConfigChanged?: (sessionName: string) => void;
}

function workspaceWriteActionErrorCode(code: string | undefined): ActionErrorCode {
  if (code === "CONFIG_EXISTS") return "config_exists";
  if (code === "WORKSPACE_WRITE_FAILED") return "workspace_write_failed";
  return "config_validation_failed";
}

async function mutateConfigAction<Result>(
  input: { projectName?: string },
  deps: ConfigActionDeps,
  fn: (dir: string) => Result,
): Promise<Result> {
  const context = await resolveProjectContext(input, deps);
  const configContext = await resolveProjectConfigContext(context.dir);
  if (!configContext.configExists) {
    throw new ActionError({
      code: "config_missing",
      message: "workspace config was not found",
      details: { dir: context.dir },
    });
  }
  try {
    const result = fn(configContext.configWriteRoot);
    (deps.broadcastConfigChanged ?? broadcastConfigChangedDefault)(context.sessionName);
    return result;
  } catch (err) {
    if (err instanceof UnsupportedLegacyConfigMutationError) {
      throw new ActionError({
        code: "legacy_config_mutation_unsupported",
        message: err.message,
        details: { diagnostics: err.diagnostics },
        cause: err,
      });
    }
    if (err instanceof WorkspaceConfigWriteError) {
      throw new ActionError({
        code: workspaceWriteActionErrorCode(err.code),
        message: err.message,
        details: { path: err.path },
        cause: err,
      });
    }
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

export async function configSetHandler(
  input: ActionInput<"config.set">,
  deps: ConfigActionDeps = {},
): Promise<ActionResult<"config.set">> {
  const config = await mutateConfigAction(input, deps, (dir) =>
    configSetValue(dir, input.path, input.value),
  );
  return { config };
}

export async function configAddPaneHandler(
  input: ActionInput<"config.addPane">,
  deps: ConfigActionDeps = {},
): Promise<ActionResult<"config.addPane">> {
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
  const config = await mutateConfigAction(input, deps, (dir) =>
    configAddPane(dir, input.rowIndex, pane),
  );
  return { config };
}

export async function configRemovePaneHandler(
  input: ActionInput<"config.removePane">,
  deps: ConfigActionDeps = {},
): Promise<ActionResult<"config.removePane">> {
  const config = (
    await mutateConfigAction(input, deps, (dir) =>
      configRemovePane(dir, input.rowIndex, input.paneIndex),
    )
  ).config;
  return { config };
}

export async function configAddRowHandler(
  input: ActionInput<"config.addRow">,
  deps: ConfigActionDeps = {},
): Promise<ActionResult<"config.addRow">> {
  const config = await mutateConfigAction(input, deps, (dir) => configAddRow(dir, input.size));
  return { config };
}

export async function configEnableTeamHandler(
  input: ActionInput<"config.enableTeam">,
  deps: ConfigActionDeps = {},
): Promise<ActionResult<"config.enableTeam">> {
  const config = await mutateConfigAction(input, deps, (dir) => configEnableTeam(dir, input.name));
  return { config };
}

export async function configDisableTeamHandler(
  input: ActionInput<"config.disableTeam">,
  deps: ConfigActionDeps = {},
): Promise<ActionResult<"config.disableTeam">> {
  const config = await mutateConfigAction(input, deps, (dir) => configDisableTeam(dir));
  return { config };
}
