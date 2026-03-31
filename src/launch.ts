import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  setPaneOption,
  setPaneTitle,
  setSessionEnvironment,
  setSessionVariable,
  splitPane,
  startSessionMonitor,
} from "./lib/tmux.ts";
import { validateConfig } from "./validate.ts";
import { resolveWidgetCommand } from "./widgets/resolve.ts";
import { shellEscape } from "./lib/shell.ts";
import type { IdeConfig, Row, Pane } from "./types.ts";

const DEFAULT_COMMAND_CENTER_PORT = 6060;
const DEFAULT_DASHBOARD_PORT = 6061;

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveDashboardDir(rootDir = packageRoot()): string | null {
  const dashboardDir = join(rootDir, "dashboard");
  return existsSync(join(dashboardDir, "package.json")) ? dashboardDir : null;
}

export function startDashboard(
  session: string,
  apiPort: number,
  {
    dashboardPort = DEFAULT_DASHBOARD_PORT,
    dashboardDir = resolveDashboardDir(),
    spawnFn = spawn,
    setVar = setSessionVariable,
  }: {
    dashboardPort?: number;
    dashboardDir?: string | null;
    spawnFn?: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => { pid?: number; unref: () => void };
    setVar?: (sessionName: string, name: string, value: string) => void;
  } = {},
): string | null {
  if (!dashboardDir) return null;

  const url = `http://localhost:${dashboardPort}`;
  const child = spawnFn("pnpm", ["dev", "--port", String(dashboardPort)], {
    cwd: dashboardDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`,
    },
  });
  child.unref();

  if (child.pid != null) {
    setVar(session, "@dashboard_pid", String(child.pid));
  }
  setVar(session, "@dashboard_url", url);
  return url;
}

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
    execSync(command, { cwd: dir, stdio: "inherit", timeout: 60_000 });
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
    const commandCenterUrl = `http://localhost:${config.orchestrator?.port ?? config.command_center?.port ?? DEFAULT_COMMAND_CENTER_PORT}`;
    const dashboardUrl = getSessionVariable(session, "@dashboard_url");

    if (json) {
      console.log(
        JSON.stringify({ session, running: true, configChanged, commandCenterUrl, dashboardUrl }),
      );
    } else if (configChanged) {
      console.log(`Session "${session}" is running but ide.yml has changed.`);
      console.log(`Run "tmux-ide restart" to apply changes.`);
    } else {
      console.log(`Session "${session}" is already running. Attaching...`);
      console.log(`Command Center: ${commandCenterUrl}`);
      if (dashboardUrl) {
        console.log(`Dashboard: ${dashboardUrl}`);
      }
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

  // Start background daemon watchdog (command center + session monitor)
  const monitorScript = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "lib",
    "daemon-watchdog.ts",
  );
  const commandCenterPort =
    config.orchestrator?.port ?? config.command_center?.port ?? DEFAULT_COMMAND_CENTER_PORT;
  startSessionMonitor(session, monitorScript, commandCenterPort);
  const dashboardPort = config.dashboard?.port ?? DEFAULT_DASHBOARD_PORT;
  const dashboardUrl = startDashboard(session, commandCenterPort, {
    dashboardPort,
  });

  // Inject master agent prompt and task docs if orchestrator is enabled
  if (config.orchestrator?.enabled) {
    ensureTaskDocs(dir);

    const masterPaneTitle = config.orchestrator.master_pane;
    if (masterPaneTitle) {
      const masterAction = paneActions.find((a) => a.title === masterPaneTitle);
      if (masterAction) {
        const masterPrompt = buildMasterAgentPrompt(config);
        setTimeout(() => {
          sendLiteral(masterAction.targetPane, masterPrompt);
        }, 5000);
      }
    }
  }

  // Focus the correct pane
  selectPane(focusPane);

  // Launch summary
  const totalPanes = rows.reduce((sum, r) => sum + (r.panes?.length ?? 0), 0);
  console.log(
    `Starting "${session}" (${rows.length} row${rows.length === 1 ? "" : "s"}, ${totalPanes} pane${totalPanes === 1 ? "" : "s"})...`,
  );
  console.log(`Command Center: http://localhost:${commandCenterPort}`);
  if (dashboardUrl) {
    console.log(`Dashboard: ${dashboardUrl}`);
  }

  // Attach
  if (attach) {
    attachSession(session);
  }
}

export function buildMasterAgentPrompt(config: IdeConfig): string {
  const teammatePanes = config.rows
    .flatMap((r) => r.panes ?? [])
    .filter((p: Pane) => p.role === "teammate" && p.command === "claude")
    .map((p: Pane) => p.title)
    .filter(Boolean);

  return `You are the Master Agent for this tmux-ide session.

## Your role
You coordinate a team of coding agents. The human gives you high-level goals, and you break them into structured tasks that your teammates execute.

## Your teammates
${teammatePanes.map((t) => `- ${t}`).join("\n")}

## Task management commands
- tmux-ide mission set "title" --description "..."
- tmux-ide goal create "title" --priority N --acceptance "criteria"
- tmux-ide goal list --json
- tmux-ide task create "title" --goal NN --priority N
- tmux-ide task list --json
- tmux-ide task show NNN --json (shows full mission→goal→task context)
- tmux-ide task done NNN --proof "what was accomplished"
- tmux-ide goal done NN

## How it works
1. You create tasks with tmux-ide task create
2. The orchestrator automatically assigns unassigned tasks to idle teammates
3. Teammates work in the project directory
4. When teammates finish, they run tmux-ide task done
5. You get notified and review their work
6. You report progress to the human

## Important
- Focus on PLANNING and REVIEWING, not implementing
- Break work into small, clear tasks (one per teammate)
- Each task should be completable independently
- Set clear acceptance criteria in goals
- Check progress: tmux-ide task list --json`;
}

const TASK_DOCS_MARKER = "## Task Management";

const TASK_DOCS_SECTION = `
## Task Management

tmux-ide provides structured task management for coordinated multi-agent work.

### Mission & Goals

\`\`\`bash
tmux-ide mission set "title" --description "..."   # Set the project mission
tmux-ide mission show                               # Show current mission
tmux-ide mission clear                              # Clear the mission

tmux-ide goal create "title" --priority N --acceptance "criteria"
tmux-ide goal list [--json]                         # List all goals
tmux-ide goal show <id> [--json]                    # Show goal with tasks
tmux-ide goal update <id> --status done
tmux-ide goal done <id>                             # Mark goal complete
tmux-ide goal delete <id>
\`\`\`

### Tasks

\`\`\`bash
tmux-ide task create "title" --goal NN --priority N --assign "Agent" --tags "a,b" --depends "001,002"
tmux-ide task list [--status todo --goal NN] [--json]
tmux-ide task show <id> [--json]                    # Full mission→goal→task context
tmux-ide task update <id> --status review --proof '{"tests":{"passed":10,"total":10}}'
tmux-ide task claim <id> --assign "Agent Name"      # Claim and start a task
tmux-ide task done <id> --proof "description"       # Mark task complete with proof
tmux-ide task delete <id>
\`\`\`

### Proof Format

The \`--proof\` flag accepts either a plain string (stored as \`notes\`) or a JSON object:

\`\`\`json
{
  "tests": { "passed": 10, "total": 10 },
  "pr": { "number": 42, "url": "https://...", "status": "merged" },
  "ci": { "status": "passing", "url": "https://..." },
  "notes": "Additional context"
}
\`\`\`

### Task Dependencies

Use \`--depends "001,002"\` to declare that a task depends on other tasks. The orchestrator will not dispatch a task until all its dependencies are complete.
`;

export function ensureTaskDocs(dir: string): void {
  const claudeMdPath = join(dir, "CLAUDE.md");

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    if (content.includes(TASK_DOCS_MARKER)) return;
    writeFileSync(claudeMdPath, content + TASK_DOCS_SECTION);
  } else {
    writeFileSync(claudeMdPath, `# Project\n${TASK_DOCS_SECTION}`);
  }
}
