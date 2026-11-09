/**
 * The "worktree tasks" example plugin: tasks as git worktrees, each with its
 * own tmux session, through tmux-ide's own `tmux-ide worktree` command.
 *
 * `tmux-ide plugin example worktree-tasks` copies these files into
 * ~/.tmux-ide/plugins/worktree-tasks; it then runs only after
 * `tmux-ide plugin consent worktree-tasks`.
 *
 * It needs only `exec: ["tmux-ide"]`: it finds the repository from the
 * session the palette was opened in (`ctx.session`, passed as --session), so
 * it never types into a pane and works from the TUI, the CLI and the Mac app.
 */
export const WORKTREE_TASKS_MANIFEST = {
  name: "worktree-tasks",
  version: "1.0.0",
  api: "^1.0",
  description:
    "Tasks as git worktrees: start, open and remove them from the palette, with tmux-ide worktree.",
  capabilities: { exec: ["tmux-ide"] },
} as const;

export const WORKTREE_TASKS_INIT_LUA = String.raw`-- worktree-tasks: tasks as git worktrees, each with its own tmux session.
-- Every action runs "tmux-ide worktree ... --session <session> --json" on the
-- repository of the session the palette was opened in.

local function session_of(ctx)
  if not ctx.session then
    error("Run this from a tmux-ide session: it works on that session's repository " ..
      "(from the CLI, run it inside tmux or pass --session).", 0)
  end
  return ctx.session
end

-- Run tmux-ide worktree with args, for ctx's session; returns its JSON answer.
local function worktree(ctx, args)
  local argv = { "worktree" }
  for _, arg in ipairs(args) do argv[#argv + 1] = arg end
  argv[#argv + 1] = "--session"
  argv[#argv + 1] = session_of(ctx)
  argv[#argv + 1] = "--json"
  local result = ide.exec{ cmd = "tmux-ide", args = argv }
  if result.code ~= 0 then
    local message = result.stderr ~= "" and result.stderr or result.stdout
    message = message:gsub("%s+$", "")
    if message == "" then message = "tmux-ide worktree failed (exit " .. tostring(result.code) .. ")" end
    error(message, 0)
  end
  return ide.json.decode(result.stdout)
end

-- The task worktrees (not the main checkout), as palette choices.
local function task_choices(ctx)
  local listed = worktree(ctx, { "list" })
  local choices = {}
  for _, entry in ipairs(listed.worktrees or {}) do
    if not entry.primary and entry.branch then
      local state = entry.running and ((entry.status or "running") .. " · " .. entry.session) or "no session"
      choices[#choices + 1] = { value = entry.branch, label = entry.branch .. " · " .. state }
    end
  end
  return choices
end

local task_param = { name = "task", label = "Task", type = "choice", choices = task_choices }

ide.action.register{
  id = "new",
  title = "New task",
  category = "Tasks",
  description = "Create a worktree on a new branch and open a session in it",
  params = {
    { name = "branch", label = "Branch name", pattern = "^[%w][%w._/-]*$" },
    { name = "from", label = "Start from (branch or commit)", optional = true },
  },
  run = function(ctx, args)
    local argv = { "create", args.branch }
    if args.from then
      argv[#argv + 1] = "--from"
      argv[#argv + 1] = args.from
    end
    local made = worktree(ctx, argv)
    return "Started " .. made.branch .. " in session " .. tostring(made.session)
  end,
}

ide.action.register{
  id = "open",
  title = "Open task",
  category = "Tasks",
  description = "Open (or start) the session of a task's worktree",
  params = { task_param },
  run = function(ctx, args)
    local opened = worktree(ctx, { "open", args.task })
    return (opened.created and "Opened " or "Already open: ") .. opened.session
  end,
}

ide.action.register{
  id = "remove",
  title = "Remove task",
  category = "Tasks",
  description = "Close a task's session and remove its worktree (refused if it has changes)",
  dangerous = true,
  params = { task_param },
  run = function(ctx, args)
    local removed = worktree(ctx, { "remove", args.task })
    return "Removed " .. removed.branch .. (removed.sessionKilled and " and closed its session" or "")
  end,
}

ide.action.register{
  id = "list",
  title = "List tasks",
  category = "Tasks",
  run = function(ctx)
    local choices = task_choices(ctx)
    if #choices == 0 then return "No tasks yet. Start one with New task." end
    local lines = {}
    for _, choice in ipairs(choices) do lines[#lines + 1] = choice.label end
    return table.concat(lines, "\n")
  end,
}
`;

/** The examples `tmux-ide plugin example` can install, by name. */
export const PLUGIN_EXAMPLES: Readonly<
  Record<string, { readonly manifest: object; readonly files: Readonly<Record<string, string>> }>
> = {
  "worktree-tasks": {
    manifest: WORKTREE_TASKS_MANIFEST,
    files: { "init.lua": WORKTREE_TASKS_INIT_LUA },
  },
};
