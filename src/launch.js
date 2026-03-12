import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { readConfig, getSessionName } from "./lib/yaml-io.js";
import { computeSizes, toSplitPercents } from "./lib/sizes.js";

function tmux(cmd) {
  execSync(`tmux ${cmd}`, { stdio: "inherit" });
}

function tmuxQuiet(cmd) {
  try {
    execSync(`tmux ${cmd}`, { stdio: "ignore" });
  } catch {}
}

export async function launch(targetDir) {
  const dir = resolve(targetDir ?? ".");

  let config;
  try {
    ({ config } = readConfig(dir));
  } catch {
    console.error(`No ide.yml found in ${dir}. Run "tmux-ide init" to create one.`);
    process.exit(1);
  }

  // Validate config structure before building tmux session
  if (!Array.isArray(config.rows) || config.rows.length === 0) {
    console.error("Invalid ide.yml: 'rows' must be a non-empty array");
    console.error("Run: tmux-ide validate");
    process.exit(1);
  }
  for (const row of config.rows) {
    if (!Array.isArray(row.panes) || row.panes.length === 0) {
      console.error("Invalid ide.yml: each row must have a non-empty 'panes' array");
      console.error("Run: tmux-ide validate");
      process.exit(1);
    }
  }

  const session = config.name ?? getSessionName(dir);
  const rows = config.rows;
  const theme = config.theme ?? {};
  const team = config.team ?? null;

  // Run before hook
  if (config.before) {
    console.log(`Running: ${config.before}`);
    try {
      execSync(config.before, { cwd: dir, stdio: "inherit" });
    } catch (e) {
      console.error(`"before" hook failed: ${config.before}`);
      process.exit(1);
    }
  }

  // If session already exists, just attach to it
  try {
    execSync(`tmux has-session -t "${session}"`, { stdio: "ignore" });
    console.log(`Session "${session}" is already running. Attaching...`);
    tmux(`attach -t "${session}"`);
    return;
  } catch {
    // Session doesn't exist, continue with creation
  }

  // Get terminal dimensions
  const cols = process.stdout.columns ?? 200;
  const lines = process.stdout.rows ?? 50;

  // Query tmux base indices to respect user's tmux.conf settings
  let baseIndex = 0;
  let paneBaseIndex = 0;
  try {
    baseIndex = parseInt(execSync("tmux show-option -gv base-index", { encoding: "utf8" }).trim(), 10) || 0;
  } catch {}
  try {
    paneBaseIndex = parseInt(execSync("tmux show-option -gv pane-base-index", { encoding: "utf8" }).trim(), 10) || 0;
  } catch {}
  const win = baseIndex; // first window index

  // Create session with first pane
  tmux(`new-session -d -s "${session}" -c "${dir}" -x ${cols} -y ${lines}`);

  // Set agent teams env var if team config is present
  if (team) {
    tmux(`set-environment -t "${session}" CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 1`);
  }

  // Compute row sizes and convert to tmux split percentages
  const rowSizes = computeSizes(rows);
  const rowSplitPercents = toSplitPercents(rowSizes);

  // Phase 1: Create all rows (vertical splits) BEFORE any horizontal splits.
  // This ensures each row spans the full window width.
  const rowPaneIndices = [paneBaseIndex]; // rowPaneIndices[i] = tmux pane index for row i
  let nextPaneIndex = paneBaseIndex + 1;

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const splitFrom = rowPaneIndices[rowIdx - 1];
    tmux(
      `split-window -t "${session}:${win}.${splitFrom}" -v -c "${dir}" -p ${rowSplitPercents[rowIdx - 1]}`
    );
    rowPaneIndices.push(nextPaneIndex);
    nextPaneIndex++;
  }

  // Phase 2: Create panes within each row (horizontal splits).
  // paneMap[row][col] = tmux pane index
  const paneMap = [];
  const firstPanesOfRows = new Set(rowPaneIndices);

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];
    const rowPane = rowPaneIndices[rowIdx];
    const rowPanes = [rowPane];

    // Compute pane sizes within this row and convert to split percentages
    const paneSizes = computeSizes(panes);
    const paneSplitPercents = toSplitPercents(paneSizes);

    // Split this row's panes horizontally
    for (let paneIdx = 1; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx];
      const targetPane = rowPanes[paneIdx - 1];

      // Per-pane working directory
      const paneDir = pane.dir ? resolve(dir, pane.dir) : dir;

      tmux(
        `split-window -t "${session}:${win}.${targetPane}" -h -c "${paneDir}" -p ${paneSplitPercents[paneIdx - 1]}`
      );
      rowPanes.push(nextPaneIndex);
      nextPaneIndex++;
    }

    paneMap.push(rowPanes);
  }

  // Build the command for a pane, transforming claude commands for team roles
  function buildCommand(p) {
    if (!p.command) return null;
    if (!team || !p.role) return p.command;

    if (p.role === "lead") {
      return `claude --team "${team.name}"`;
    } else if (p.role === "teammate") {
      let cmd = `claude --teammate-mode in-process --team "${team.name}"`;
      if (p.task) {
        cmd += ` --task "${p.task.replace(/"/g, '\\"')}"`;
      }
      return cmd;
    }
    return p.command;
  }

  // Send commands, set titles, handle env/focus/dir for first panes
  // Two-pass approach for teams: lead + non-teammates first, then teammates
  let focusPane = paneMap[0][0];
  const teammateCommands = [];

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];
    for (let paneIdx = 0; paneIdx < panes.length; paneIdx++) {
      const p = panes[paneIdx];
      const tmuxPane = paneMap[rowIdx][paneIdx];

      if (p.title) {
        tmux(`select-pane -t "${session}:${win}.${tmuxPane}" -T "${p.title}"`);
      }

      // Per-pane directory for first panes of each row (created with project root)
      if (p.dir && firstPanesOfRows.has(tmuxPane)) {
        const paneDir = resolve(dir, p.dir);
        tmux(`send-keys -t "${session}:${win}.${tmuxPane}" "cd ${paneDir}" C-m`);
      }

      // Environment variables
      if (p.env && typeof p.env === "object") {
        for (const [key, val] of Object.entries(p.env)) {
          tmux(`send-keys -t "${session}:${win}.${tmuxPane}" "export ${key}=${val}" C-m`);
        }
      }

      const cmd = buildCommand(p);
      if (cmd) {
        if (team && p.role === "teammate") {
          // Defer teammate launches to second pass
          teammateCommands.push({ pane: tmuxPane, cmd });
        } else {
          tmux(`send-keys -t "${session}:${win}.${tmuxPane}" "${cmd}" C-m`);
        }
      }

      if (p.focus) {
        focusPane = tmuxPane;
      }
    }
  }

  // Second pass: launch teammates after a brief delay for the lead to initialize
  if (teammateCommands.length > 0) {
    execSync("sleep 2");
    for (const { pane: p, cmd } of teammateCommands) {
      tmux(`send-keys -t "${session}:${win}.${p}" "${cmd}" C-m`);
    }
  }

  // Apply styling
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const bg = theme.bg ?? "colour235";
  const fg = theme.fg ?? "colour248";

  tmux(`set-option -t "${session}" pane-border-status top`);
  tmux(
    `set-option -t "${session}" pane-border-format " #{?pane_active,#[bold]▸,·} #T "`
  );
  tmux(`set-option -t "${session}" pane-border-style "fg=${border}"`);
  tmux(`set-option -t "${session}" pane-active-border-style "fg=${accent}"`);

  tmux(`set-option -t "${session}" status-style "bg=${bg},fg=${fg}"`);
  tmux(
    `set-option -t "${session}" status-left "#[fg=colour0,bg=${accent},bold]  ${session.toUpperCase()} IDE #[default] "`
  );
  tmux(`set-option -t "${session}" status-left-length 30`);
  tmux(
    `set-option -t "${session}" status-right "#[fg=colour243]%H:%M #[fg=${accent}]│ #[fg=${fg}]%b %d "`
  );
  tmux(`set-option -t "${session}" status-justify centre`);
  tmux(
    `set-option -t "${session}" window-status-current-format "#[fg=${accent},bold]●"`
  );
  tmux(
    `set-option -t "${session}" window-status-format "#[fg=${border}]○"`
  );

  // Focus the correct pane
  tmux(`select-pane -t "${session}:${win}.${focusPane}"`);

  // Launch summary
  const totalPanes = rows.reduce((sum, r) => sum + (r.panes?.length ?? 0), 0);
  console.log(`Starting "${session}" (${rows.length} row${rows.length === 1 ? "" : "s"}, ${totalPanes} pane${totalPanes === 1 ? "" : "s"})...`);

  // Attach
  tmux(`attach -t "${session}"`);
}
