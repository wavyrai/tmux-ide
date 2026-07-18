import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveProjectConfigContext, type ProjectConfigContext } from "./lib/config-context.ts";
import { computeSizes, toSplitPercents } from "./lib/sizes.ts";
import { outputError } from "./lib/output.ts";
import { collectPaneStartupPlan } from "./lib/launch-plan.ts";
import { buildSessionOptions } from "./lib/session-options.ts";
import {
  attachSession,
  createDetachedSession,
  getPaneCurrentCommand,
  getSessionVariable,
  hasSession,
  runSessionCommand,
  selectPane,
  sendLiteral,
  setPaneOption,
  setPaneTitle,
  setSessionEnvironment,
  setSessionVariable,
  splitPane,
} from "@tmux-ide/tmux-bridge";
import { validateConfig } from "./validate.ts";
import { resolveSidebarConfig } from "./tui/chrome/sidebar.ts";
import { resolveWidgetCommand } from "./widgets/resolve.ts";
import { shellEscape } from "./lib/shell.ts";
import type { IdeConfig, Row } from "./types.ts";

function stripWidgetPanes(rows: Row[]): Row[] {
  return rows
    .map((row) => ({
      ...row,
      panes: row.panes.filter((p) => !p.type),
    }))
    .filter((row) => row.panes.length > 0);
}

interface SplitPaneArgs {
  targetPane: string;
  direction: "vertical" | "horizontal";
  cwd: string;
  percent: number;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function configHash(config: IdeConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
}

export function waitForPaneCommand(
  targetPane: string,
  expectedCommands: string[],
  {
    attempts = 20,
    delayMs = 100,
    getCurrentCommand = getPaneCurrentCommand,
    sleep = sleepMs,
  }: {
    attempts?: number;
    delayMs?: number;
    getCurrentCommand?: (pane: string) => string;
    sleep?: (ms: number) => void;
  } = {},
): boolean {
  const allowed = new Set(expectedCommands.map((command) => command.toLowerCase()));

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const current = getCurrentCommand(targetPane)?.trim().toLowerCase();
      if (current && allowed.has(current)) return true;
    } catch {
      // Fall through to retry; tmux can briefly report transitional state.
    }

    if (attempt < attempts - 1) {
      sleep(delayMs);
    }
  }

  return false;
}

export function buildPaneMap(
  rows: Row[],
  dir: string,
  rootPaneId: string,
  splitPaneFn: (args: SplitPaneArgs) => string,
): { paneMap: string[][]; firstPanesOfRows: Set<string> } {
  const rowSizes = computeSizes(rows);
  const rowSplitPercents = toSplitPercents(rowSizes);

  // Create all rows vertically first so each row spans the full width.
  const rowPaneIds = [rootPaneId];
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const splitFrom = rowPaneIds[rowIdx - 1]!;
    const newPaneId = splitPaneFn({
      targetPane: splitFrom,
      direction: "vertical",
      cwd: dir,
      percent: rowSplitPercents[rowIdx - 1]!,
    });
    rowPaneIds.push(newPaneId);
  }

  const paneMap: string[][] = [];
  const firstPanesOfRows = new Set(rowPaneIds);

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    const panes = row.panes ?? [];
    const rowPaneId = rowPaneIds[rowIdx]!;
    const rowPanes = [rowPaneId];

    const paneSizes = computeSizes(panes);
    const paneSplitPercents = toSplitPercents(paneSizes);

    for (let paneIdx = 1; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx]!;
      const targetPane = rowPanes[paneIdx - 1]!;
      const paneDir = pane.dir ? resolve(dir, pane.dir) : dir;
      const newPaneId = splitPaneFn({
        targetPane,
        direction: "horizontal",
        cwd: paneDir,
        percent: paneSplitPercents[paneIdx - 1]!,
      });
      rowPanes.push(newPaneId);
    }

    paneMap.push(rowPanes);
  }

  return { paneMap, firstPanesOfRows };
}

async function loadLaunchConfig(context: ProjectConfigContext, json: boolean): Promise<IdeConfig> {
  const config = context.resolved?.launchConfig ?? null;

  if (!config) {
    outputError(
      `No workspace config found in ${context.inputDir}. Run "tmux-ide init" or "tmux-ide detect --write" to create one.`,
      "CONFIG_NOT_FOUND",
    );
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    const configLocation = context.configPath ?? context.inputDir ?? context.projectRoot;
    outputError(
      `Invalid workspace config in ${configLocation}. Run "tmux-ide validate" for details.`,
      "INVALID_CONFIG",
    );
  }

  if (context.resolved?.migrationHint && !json && !process.env.TMUX_IDE_SUPPRESS_MIGRATION_HINT) {
    console.log(context.resolved.migrationHint);
  }
  return config;
}

/**
 * Best-effort: adopt the session into the native chrome (status bar + switcher
 * popup + the shared background updater). A chrome failure must NEVER break
 * launch, so it's fully swallowed; the import is dynamic to keep the hot path
 * clean and the data-layer graph out of the common launch flow.
 */
async function bestEffortAdopt(session: string): Promise<void> {
  try {
    const { adoptSession } = await import("./tui/chrome/statusline.ts");
    adoptSession(session);
  } catch {
    // chrome is optional — never let it block the session
  }
}

function runBeforeHook(command: string | undefined, dir: string): void {
  if (!command) return;

  console.log(`Running: ${command}`);

  try {
    execSync(command, { cwd: dir, stdio: "inherit", timeout: 60_000 });
  } catch {
    outputError(`The before hook failed: ${command}`, "BEFORE_HOOK_FAILED");
  }
}

export function launchRuntimeDir(context: ProjectConfigContext): string {
  return context.configWriteRoot;
}

export async function launch(
  targetDir: string | undefined,
  {
    json = false,
    attach = true,
    sessionName,
  }: { json?: boolean; attach?: boolean; sessionName?: string } = {},
): Promise<void> {
  const inputDir = resolve(targetDir ?? ".");
  const context = await resolveProjectConfigContext(inputDir);
  const dir = launchRuntimeDir(context);
  const config = await loadLaunchConfig(context, json);

  // A `sessionName` override lets a worktree checkout run under its own session
  // name (e.g. `app@branch`) instead of colliding with the parent repo's
  // `config.name`; the whole flow keys off `session`, so the override threads
  // through session creation, adoption, and drift detection unchanged.
  const session = sessionName ?? config.name ?? context.sessionName;
  const headless = config.orchestrator?.widgets === false;
  const rows = headless ? stripWidgetPanes(config.rows) : config.rows;
  const theme = config.theme ?? {};
  const team = config.team ?? null;

  runBeforeHook(config.before, dir);

  // If session already exists, check for config drift and attach
  if (hasSession(session)) {
    const currentHash = configHash(config);
    const storedHash = getSessionVariable(session, "@config_hash");
    const configChanged = Boolean(storedHash && currentHash !== storedHash);

    if (json) {
      console.log(JSON.stringify({ session, running: true, configChanged }));
    } else if (configChanged) {
      console.log(`Session "${session}" is running but workspace config has changed.`);
      console.log(`Run "tmux-ide restart" to apply changes.`);
    } else {
      console.log(`Session "${session}" is already running. Attaching...`);
    }

    // Keep the chrome in place across re-launches (idempotent).
    await bestEffortAdopt(session);
    if (attach) {
      attachSession(session);
    }
    return;
  }

  // Get terminal dimensions
  const cols = process.stdout.columns ?? 200;
  const lines = process.stdout.rows ?? 50;

  // Create session with first pane
  const rootPaneId = createDetachedSession(session, dir, { cols, lines });

  // Set agent teams env var if team config is present
  if (team) {
    setSessionEnvironment(session, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1");
  }

  const { paneMap, firstPanesOfRows } = buildPaneMap(
    rows,
    dir,
    rootPaneId,
    ({ targetPane, direction, cwd, percent }) => splitPane(targetPane, direction, cwd, percent),
  );

  const { focusPane, paneActions } = collectPaneStartupPlan(rows, paneMap, firstPanesOfRows, dir);

  for (const action of paneActions) {
    if (action.title) {
      setPaneTitle(action.targetPane, action.title);
    }

    // Set pane identity options for discovery by orchestrator/widgets
    setPaneOption(action.targetPane, "@ide_role", action.paneRole ?? "shell");
    setPaneOption(action.targetPane, "@ide_name", action.title ?? "");
    setPaneOption(action.targetPane, "@ide_type", action.paneType ?? "shell");

    // Lock agent pane titles so Claude Code can't overwrite them
    if (action.paneRole === "lead" || action.paneRole === "teammate") {
      setPaneOption(action.targetPane, "allow-rename", "off");
    }

    if (action.chdir) {
      sendLiteral(action.targetPane, `cd ${shellEscape(action.chdir)}`);
    }

    for (const exportCommand of action.exports) {
      sendLiteral(action.targetPane, exportCommand);
    }

    if (action.widgetType) {
      const widgetCmd = resolveWidgetCommand(action.widgetType, {
        session,
        dir,
        target: action.widgetTarget ?? null,
        theme: config.theme ?? null,
      });
      sendLiteral(action.targetPane, widgetCmd);
    } else if (action.command) {
      sendLiteral(action.targetPane, action.command);
    }
  }

  for (const command of buildSessionOptions(session, { theme })) {
    runSessionCommand(command);
  }

  // Store config hash for drift detection on re-launch
  setSessionVariable(session, "@config_hash", configHash(config));

  // Sidebar sugar: `sidebar: true` (or `{ width }`) injects the app nav column
  // as a full-height left split of the whole window (`-h -b -f`), built AFTER
  // the rows so `-f` spans their combined height. Best-effort — the layout must
  // never fail because the chrome column couldn't open.
  const sidebar = resolveSidebarConfig(config.sidebar);
  if (sidebar.enabled) {
    try {
      const { openSidebarPane } = await import("./tui/chrome/sidebar.ts");
      openSidebarPane(session, dir, sidebar.width, config.theme ?? null);
    } catch {
      // sidebar is optional chrome — never block launch
    }
  }

  // Focus the correct pane (the sidebar split above steals focus to itself).
  selectPane(focusPane);

  // Launch summary
  const totalPanes = rows.reduce((sum, r) => sum + (r.panes?.length ?? 0), 0);
  console.log(
    `Starting "${session}" (${rows.length} row${rows.length === 1 ? "" : "s"}, ${totalPanes} pane${totalPanes === 1 ? "" : "s"})...`,
  );

  // Surface the command-center URL so users know where the API lives.
  // Read the canonical daemon info file the daemon writes on startup;
  // tolerate its absence (daemon may still be coming up, or running
  // sessionless). Print only when we have a real port to advertise.
  try {
    const { readCanonicalDaemonInfo } = await import("./lib/canonical-daemon.ts");
    const info = readCanonicalDaemonInfo();
    if (info) {
      console.log(`Command center: http://${info.bindHostname}:${info.port}/`);
    }
  } catch {
    // Non-fatal — the daemon may still be coming up.
  }

  // Adopt into the native chrome so the new session shows the tmux-ide bar.
  await bestEffortAdopt(session);

  // Attach
  if (attach) {
    attachSession(session);
  }
}
