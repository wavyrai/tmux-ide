import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  ProjectAlreadyRegisteredError,
  registerProject,
} from "../../../../lib/project-registry.ts";
import {
  PICKER_HIDDEN_ID,
  PICKER_OPEN_ID,
  PICKER_TYPE_ID,
  PICKER_UP_ID,
  expandUserPath,
  filterDirs,
  isPickerRoot,
  pathKindHint,
  pickerBreadcrumb,
  pickerDirName,
  pickerParent,
  pickerRows,
  type PathKind,
} from "../../folder-picker.ts";
import type {
  DialogConfirmRequest,
  DialogPromptRequest,
  DialogSelectRequest,
} from "../dialogs/contract.ts";

export { HomeSurface } from "../../home-surface.tsx";
export {
  homeActionAtProjection,
  homeItemIndexAtProjection,
  projectHomeSurface,
} from "../../home-surface-model.ts";
export { executeTuiAgentProvisioning } from "../../agent-provisioning-executor.ts";

interface HomeDialogPort {
  readonly select: (
    request: DialogSelectRequest,
  ) => Promise<{ readonly item: { readonly id: string } } | null>;
  readonly prompt: (request: DialogPromptRequest) => Promise<string | null>;
  readonly confirm: (request: DialogConfirmRequest) => Promise<boolean>;
}

export interface OpenFolderFlowOptions {
  readonly start: string;
  readonly dialogs: HomeDialogPort;
  readonly openFolder: (dir: string) => void;
  readonly setStatusNote: (message: string) => void;
  readonly refreshFleet: () => void;
  readonly writeDetectedLayout: (dir: string) => void;
  /** Test seam; production keeps project registration inside this deferred module. */
  readonly register?: typeof registerProject;
  /** Test seam; production resolves the optional project config on demand. */
  readonly hasProjectConfig?: (dir: string) => Promise<boolean>;
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function pathKind(path: string): Promise<PathKind> {
  try {
    return (await stat(path)).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

async function defaultHasProjectConfig(dir: string): Promise<boolean> {
  const { resolveProjectConfigContext } = await import("../../../../lib/config-context.ts");
  return (await resolveProjectConfigContext(dir)).configKind !== "none";
}

async function runTypedPath(base: string, dialogs: HomeDialogPort): Promise<string | null> {
  let initial = "";
  let footerHint = "type a folder path — ~ and relative paths are ok";
  for (;;) {
    const typed = await dialogs.prompt({
      title: "Open a folder by path",
      placeholder: "~/code/my-project",
      initial,
      footerHint,
      validate: (value) =>
        value.trim().length > 0 ? null : "Type a path, or press esc to go back",
    });
    if (typed === null) return null;
    const resolved = expandUserPath(typed, homedir(), base);
    const kind = await pathKind(resolved);
    if (kind === "dir") return resolved;
    initial = typed;
    footerHint = pathKindHint(kind);
  }
}

async function runFolderPicker(start: string, dialogs: HomeDialogPort): Promise<string | null> {
  let dir = start;
  let showHidden = false;
  for (;;) {
    const subdirs = filterDirs(await listSubdirs(dir), showHidden);
    const choice = await dialogs.select({
      title: pickerBreadcrumb(dir, homedir()),
      items: pickerRows(dir, subdirs, showHidden),
    });
    if (!choice) return null;
    const id = choice.item.id;
    if (id === PICKER_OPEN_ID) return dir;
    if (id === PICKER_HIDDEN_ID) {
      showHidden = !showHidden;
      continue;
    }
    if (id === PICKER_UP_ID) {
      if (!isPickerRoot(dir)) dir = pickerParent(dir);
      continue;
    }
    if (id === PICKER_TYPE_ID) {
      const typed = await runTypedPath(dir, dialogs);
      if (typed !== null) return typed;
      continue;
    }
    const name = pickerDirName(id);
    if (name) dir = join(dir, name);
  }
}

/** Demand-only Home action flow. Cancellation stays silent; all prior errors remain user-visible. */
export async function runOpenFolderFlow(options: OpenFolderFlowOptions): Promise<void> {
  const dir = await runFolderPicker(options.start, options.dialogs);
  if (!dir) return;

  options.openFolder(dir);
  const remember = await options.dialogs.confirm({
    title: "Remember this project?",
    body:
      "Add it to your projects so it's one click to reopen next time. " +
      "This opens your project in a terminal workspace either way.",
    yesLabel: "Remember it",
    noLabel: "Not now",
  });
  if (remember) {
    try {
      await (options.register ?? registerProject)({ dir });
      options.setStatusNote(`remembered ${basename(dir) || dir}`);
      options.refreshFleet();
    } catch (error) {
      options.setStatusNote(
        error instanceof ProjectAlreadyRegisteredError
          ? "already in your projects"
          : "couldn't remember that project",
      );
    }
  }

  const hasProjectConfig = options.hasProjectConfig ?? defaultHasProjectConfig;
  if (!(await hasProjectConfig(dir))) {
    const setup = await options.dialogs.confirm({
      title: "Set up a layout?",
      body:
        "Detect this project and write a starter layout so it opens with the " +
        "right panes next time. You can change it later.",
      yesLabel: "Set it up",
      noLabel: "Skip",
    });
    if (setup) options.writeDetectedLayout(dir);
  }
}
