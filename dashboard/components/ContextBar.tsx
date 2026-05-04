"use client";

import { Folder } from "lucide-react";
import { fetchMission, injectIntoProject } from "@/lib/api";
import { useToasts } from "@/lib/useToasts";

type ContextActionId = "mission" | "recap" | "status" | "redispatch";

const buttons: { id: ContextActionId; label: string }[] = [
  { id: "mission", label: "Mission" },
  { id: "recap", label: "Recap" },
  { id: "status", label: "Status" },
  { id: "redispatch", label: "Re-dispatch" },
];

async function promptForAction(projectName: string, id: ContextActionId): Promise<string | null> {
  if (id === "mission") {
    const mission = await fetchMission(projectName);
    if (!mission) return null;
    const { title, description } = mission.mission;
    return [`Mission: ${title}`, description].filter(Boolean).join("\n\n");
  }
  if (id === "recap") return "Recap what you've done since the last task";
  if (id === "status") return "/status";
  return "Please continue the active task";
}

interface TerminalHeaderProps {
  sessionName: string | null;
  title?: string | null;
  cwd?: string | null;
}

/**
 * Header that sits above the terminal panes inside `TerminalsHost`.
 *
 * Replaces the old `ContextBar` overlay used by `FullScreenTerminal`.
 * Renders the active terminal tab's identity (project + title + cwd)
 * plus a thin row of "inject into project" actions when a project is
 * active.
 */
export function TerminalHeader({ sessionName, title, cwd }: TerminalHeaderProps) {
  const { push } = useToasts();

  async function inject(id: ContextActionId) {
    if (!sessionName) return;
    try {
      const text = await promptForAction(sessionName, id);
      if (!text) {
        push({ kind: "error", title: "Failed to inject", body: "No mission found" });
        return;
      }
      const ok = await injectIntoProject(sessionName, text, { sendEnter: false });
      push({
        kind: ok ? "success" : "error",
        title: ok ? "Sent to agent" : "Failed to inject",
      });
    } catch (error) {
      push({
        kind: "error",
        title: "Failed to inject",
        body: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div
      data-testid="terminal-header"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-weak)] bg-[var(--surface)] px-2"
    >
      <Folder aria-hidden="true" size={12} className="shrink-0 text-[var(--accent)]" />
      <span className="truncate text-[11px] text-[var(--fg-secondary)]">
        {sessionName ?? "no session"}
      </span>
      {title && (
        <>
          <span className="text-[var(--dimmer)]">/</span>
          <span className="truncate text-[11px] text-[var(--accent)]">{title}</span>
        </>
      )}
      {cwd && (
        <span className="ml-2 truncate text-[10px] text-[var(--dim)]" title={cwd}>
          {cwd}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {buttons.map((button) => (
          <button
            key={button.id}
            type="button"
            data-testid={`context-bar-button-${button.id}`}
            disabled={!sessionName}
            onClick={() => void inject(button.id)}
            className="h-6 rounded border border-[var(--border)] bg-[var(--bg)] px-2 text-[11px] text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--fg-secondary)]"
          >
            {button.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * @deprecated Old `ContextBar` was rendered inside the
 * `FullScreenTerminal` overlay (now removed). New code should use
 * `<TerminalHeader>` from this module — it is mounted by `TerminalsHost`
 * and gets its identity props from the active terminal tab. Kept as a
 * no-op for any stale imports.
 */
export function ContextBar() {
  return null;
}
