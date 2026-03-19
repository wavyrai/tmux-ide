import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readConfig, getSessionName } from "./lib/yaml-io.ts";
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
  setPaneTitle,
  setSessionEnvironment,
  setSessionVariable,
  splitPane,
  startSessionMonitor,
} from "./lib/tmux.ts";
import { validateConfig } from "./validate.ts";
import type { IdeConfig, Row } from "./types.ts";

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

function loadLaunchConfig(dir: string): IdeConfig {
  let config;

  try {
    ({ config } = readConfig(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      outputError(
        `No ide.yml found in ${dir}. Run "tmux-ide init" or "tmux-ide detect --write" to create one.`,
        "CONFIG_NOT_FOUND",
      );
    }

    outputError(`Cannot read ide.yml: ${(error as Error).message}`, "READ_ERROR");
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    outputError(
      `Invalid ide.yml in ${dir}. Run "tmux-ide validate" for details.`,
      "INVALID_CONFIG",
    );
  }

  return config;
}

function runBeforeHook(command: string | undefined, dir: string): void {
  if (!command) return;

  console.log(`Running: ${command}`);

  try {
    execSync(command, { cwd: dir, stdio: "inherit" });
  } catch {
    outputError(`The before hook failed: ${command}`, "BEFORE_HOOK_FAILED");
  }
}

export async function launch(
  targetDir: string | undefined,
  { json = false, attach = true }: { json?: boolean; attach?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const config = loadLaunchConfig(dir);

  const { name: fallbackName } = getSessionName(dir);
  const session = config.name ?? fallbackName;
  const rows = config.rows;
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
      console.log(`Session "${session}" is running but ide.yml has changed.`);
      console.log(`Run "tmux-ide restart" to apply changes.`);
    } else {
      console.log(`Session "${session}" is already running. Attaching...`);
    }

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

    if (action.chdir) {
      sendLiteral(action.targetPane, `cd ${action.chdir}`);
    }

    for (const exportCommand of action.exports) {
      sendLiteral(action.targetPane, exportCommand);
    }

    if (action.command) {
      sendLiteral(action.targetPane, action.command);
    }
  }

  for (const command of buildSessionOptions(session, { theme })) {
    runSessionCommand(command);
  }

  // Store config hash for drift detection on re-launch
  setSessionVariable(session, "@config_hash", configHash(config));

  // Start background session monitor (port detection + agent status)
  const monitorScript = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "lib",
    "session-monitor.ts",
  );
  startSessionMonitor(session, monitorScript);

  // Focus the correct pane
  selectPane(focusPane);

  // Launch summary
  const totalPanes = rows.reduce((sum, r) => sum + (r.panes?.length ?? 0), 0);
  console.log(
    `Starting "${session}" (${rows.length} row${rows.length === 1 ? "" : "s"}, ${totalPanes} pane${totalPanes === 1 ? "" : "s"})...`,
  );

  // Attach
  if (attach) {
    attachSession(session);
  }
}
