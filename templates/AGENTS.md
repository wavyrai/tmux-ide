# Agent Guidelines

## Project: {{name}}

## Boundaries

- Stay within the scope of your assigned task
- Surface out-of-scope issues to the lead instead of silently expanding scope
- Do not modify files outside your task scope without coordination

## Conventions

- Run tests before reporting your work done
- Use the project's existing code style
- Reference the task or branch in commit messages

## Status & Reporting

Report your state so the fleet tabs show ground truth. Claude Code does this
automatically once `tmux-ide integration install claude` is run; any agent can
self-report the same way:

    tmux set-option -p @agent_state "working:$(date +%s)"   # working|blocked|done|idle

Coordinate with the lead or a teammate pane:

    tmux-ide send <session-or-pane> "what changed, how you verified it, follow-ups"
