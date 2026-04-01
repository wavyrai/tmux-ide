import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

async function waitForDaemon(port: number, maxAttempts = 30, delayMs = 100): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function isDaemonAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
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
    const commandCenterPort =
      config.orchestrator?.port ?? config.command_center?.port ?? DEFAULT_COMMAND_CENTER_PORT;
    const commandCenterUrl = `http://localhost:${commandCenterPort}`;

    // Verify daemon is alive, restart if dead
    const daemonAlive = await isDaemonAlive(commandCenterPort);
    if (!daemonAlive) {
      console.log("Daemon not responding — restarting...");

      // Clean up any orphaned daemon processes from previous runs
      try {
        execSync(`pkill -f "daemon-watchdog.ts ${session}" 2>/dev/null || true`, {
          stdio: "ignore",
        });
        execSync(`pkill -f "daemon.ts ${session}" 2>/dev/null || true`, { stdio: "ignore" });
      } catch {
        // Best-effort cleanup
      }

      // Brief wait for orphaned processes to release the port
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await sleep(500);

      const monitorScript = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "lib",
        "daemon-watchdog.ts",
      );
      startSessionMonitor(session, monitorScript, commandCenterPort);
      await waitForDaemon(commandCenterPort);
    }

    if (json) {
      console.log(JSON.stringify({ session, running: true, configChanged, commandCenterUrl }));
    } else if (configChanged) {
      console.log(`Session "${session}" is running but ide.yml has changed.`);
      console.log(`Run "tmux-ide restart" to apply changes.`);
    } else {
      console.log(`Session "${session}" is already running. Attaching...`);
      console.log(`Dashboard: ${commandCenterUrl}`);
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

  // Clean up any orphaned daemon processes from previous runs
  try {
    execSync(`pkill -f "daemon-watchdog.ts ${session}" 2>/dev/null || true`, { stdio: "ignore" });
    execSync(`pkill -f "daemon.ts ${session}" 2>/dev/null || true`, { stdio: "ignore" });
  } catch {
    // Best-effort cleanup
  }

  // Brief wait for orphaned processes to release the port
  const sleepAsync = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleepAsync(500);

  // Start background daemon watchdog (command center + session monitor)
  const monitorScript = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "lib",
    "daemon-watchdog.ts",
  );
  const commandCenterPort =
    config.orchestrator?.port ?? config.command_center?.port ?? DEFAULT_COMMAND_CENTER_PORT;
  startSessionMonitor(session, monitorScript, commandCenterPort);

  const daemonReady = await waitForDaemon(commandCenterPort);
  if (!daemonReady) {
    console.log("Warning: daemon did not respond to health check within 3s — continuing anyway");
  }

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
  console.log(`Dashboard: http://localhost:${commandCenterPort}`);

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

  const isMissionsMode = config.orchestrator?.dispatch_mode === "missions";

  const milestonesSection = isMissionsMode
    ? `
## Milestones
Milestones gate execution — tasks in M2 won't dispatch until M1 is validated.
- tmux-ide milestone create "title" --sequence N
- tmux-ide milestone list --json
- tmux-ide mission plan-complete  (activates milestones, starts dispatch)
`
    : "";

  return `You are the Lead Agent for this tmux-ide session.

## Your role
You coordinate a team of coding agents. The human gives you high-level goals, and you break them into structured tasks that your teammates execute. You plan, delegate, and review — you do not implement.

## Your teammates
${teammatePanes.map((t) => `- ${t}`).join("\n")}

## Task management commands
- tmux-ide mission set "title" --description "..."
- tmux-ide goal create "title" --priority N --acceptance "criteria"
- tmux-ide goal list --json
- tmux-ide task create "title" --goal NN --priority N --specialty "type" --fulfills "VAL-001,VAL-002"
- tmux-ide task list --json
- tmux-ide task show NNN --json (shows full mission→goal→task context)
- tmux-ide task done NNN --proof "what was accomplished"
- tmux-ide goal done NN

## How it works
1. Set the mission: tmux-ide mission set "title" --description "..."
2. Create goals with acceptance criteria
3. Create tasks under goals — use --specialty to hint agent type, --fulfills to link validation assertions
4. The orchestrator automatically dispatches unassigned tasks to idle teammates
5. Teammates work in the project directory
6. When teammates finish, they run tmux-ide task done
7. You get notified and review their work
8. You report progress to the human
${milestonesSection}
## Validation contracts
Define acceptance criteria in .tasks/validation-contract.md using assertion IDs:
  **VAL-001**: All tests pass
  **VAL-002**: No TypeScript errors
Link tasks to assertions: tmux-ide task create "title" --fulfills "VAL-001,VAL-002"
After a milestone's tasks complete, the Validator agent automatically verifies assertions.

## Knowledge library
- .tmux-ide/library/architecture.md — project context injected into agent prompts
- .tmux-ide/library/learnings.md — auto-appended by orchestrator after task completion
- AGENTS.md — project boundaries injected into all agent prompts
Update architecture.md when the project structure changes significantly.

## Important
- Do NOT use --assign when creating tasks — the orchestrator handles dispatch automatically
- Use --specialty to hint which agent type should pick it up
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

### Milestones

\`\`\`bash
tmux-ide milestone create "title" --sequence N
tmux-ide milestone list [--json]
tmux-ide mission plan-complete  # activate milestones and start dispatch
\`\`\`

### Validation

\`\`\`bash
tmux-ide validate show [--json]
tmux-ide validate assert VAL-001 --status passing --evidence "what you verified"
tmux-ide validate coverage [--json]
\`\`\`
`;

export function ensureTaskDocs(dir: string): void {
  const claudeMdPath = join(dir, "CLAUDE.md");

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    if (!content.includes(TASK_DOCS_MARKER)) {
      writeFileSync(claudeMdPath, content + TASK_DOCS_SECTION);
    }
  } else {
    writeFileSync(claudeMdPath, `# Project\n${TASK_DOCS_SECTION}`);
  }

  // Ensure library directory and stubs exist
  const libraryDir = join(dir, ".tmux-ide", "library");
  if (!existsSync(libraryDir)) {
    mkdirSync(libraryDir, { recursive: true });
  }
  const archPath = join(libraryDir, "architecture.md");
  if (!existsSync(archPath)) {
    writeFileSync(
      archPath,
      "# Architecture\n\n<!-- Describe your project architecture here. This is injected into agent dispatch prompts. -->\n",
    );
  }
  const learningsPath = join(libraryDir, "learnings.md");
  if (!existsSync(learningsPath)) {
    writeFileSync(
      learningsPath,
      "# Learnings\n\n<!-- Task summaries are automatically appended here by the orchestrator. -->\n",
    );
  }

  // Ensure .tasks/ directory and validation contract stub
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }
  const contractPath = join(tasksDir, "validation-contract.md");
  if (!existsSync(contractPath)) {
    writeFileSync(
      contractPath,
      "# Validation Contract\n\n<!-- Define assertions for the validator agent. Example: -->\n<!-- - VAL-001: All tests pass -->\n<!-- - VAL-002: No TypeScript errors -->\n",
    );
  }
}
