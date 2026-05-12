"use client";

import {
  Files,
  Search,
  GitCompare,
  ListTodo,
  CheckSquare,
  Target,
  MessagesSquare,
  Terminal as TerminalIcon,
  UserCircle,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";

import { openCommandPalette } from "@/components/CommandPalette";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";

/**
 * VS Code-style vertical activity bar.
 *
 * Lives at the far left edge of /v2/project/[name]. The "VIEWS" list inside
 * ProjectSidebar becomes the secondary panel toggled by activity-bar
 * selection. Buttons that map to a real ViewId switch the page's `view`
 * state; non-view buttons (Search) trigger ad-hoc actions.
 *
 * Width is a fixed 48px column with a right border. Icons are top-aligned;
 * a bottom group hosts the account avatar + settings affordance.
 */

export type ActivityBarViewId =
  | "files"
  | "diffs"
  | "plans"
  | "tasks"
  | "mission"
  | "chat"
  | "terminal";

interface ActivityBarItem {
  id: ActivityBarViewId | "search" | "settings" | "account";
  Icon: LucideIcon;
  label: string;
  /** Tooltip text — defaults to label when omitted. */
  tooltip?: string;
  /** When omitted, the click handler is a no-op (placeholder for future
   *  surfaces). */
  onClick?: () => void;
  /** When provided, render as the active item if it matches the current
   *  page view. */
  view?: ActivityBarViewId;
}

interface V2ActivityBarProps {
  /** Current page view id; used to compute the active treatment. */
  view: string;
  /** Switch the page to a new view id. */
  onView: (id: ActivityBarViewId) => void;
}

export function V2ActivityBar({ view, onView }: V2ActivityBarProps) {
  const top: ActivityBarItem[] = [
    {
      id: "files",
      view: "files",
      Icon: Files,
      label: "Files",
      onClick: () => onView("files"),
    },
    {
      id: "search",
      Icon: Search,
      label: "Search",
      tooltip: "Search · ⌘K",
      onClick: openCommandPalette,
    },
    {
      id: "diffs",
      view: "diffs",
      Icon: GitCompare,
      label: "Diffs",
      onClick: () => onView("diffs"),
    },
    {
      id: "plans",
      view: "plans",
      Icon: ListTodo,
      label: "Plans",
      onClick: () => onView("plans"),
    },
    {
      id: "tasks",
      view: "tasks",
      Icon: CheckSquare,
      label: "Tasks",
      onClick: () => onView("tasks"),
    },
    {
      id: "mission",
      view: "mission",
      Icon: Target,
      label: "Mission",
      onClick: () => onView("mission"),
    },
    {
      id: "chat",
      view: "chat",
      Icon: MessagesSquare,
      label: "Chat",
      onClick: () => onView("chat"),
    },
    {
      id: "terminal",
      view: "terminal",
      Icon: TerminalIcon,
      label: "Terminal",
      onClick: () => onView("terminal"),
    },
  ];

  const bottom: ActivityBarItem[] = [
    {
      id: "account",
      Icon: UserCircle,
      label: "Account",
    },
    {
      id: "settings",
      Icon: SettingsIcon,
      label: "Settings",
    },
  ];

  return (
    <TooltipProvider delay={200}>
      <nav
        aria-label="Activity bar"
        data-testid="v2-activity-bar"
        className="flex h-full w-12 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-weak)]"
      >
        <div className="flex flex-col">
          {top.map((item) => (
            <ActivityBarButton
              key={item.id}
              item={item}
              active={item.view !== undefined && item.view === view}
            />
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex flex-col">
          {bottom.map((item) => (
            <ActivityBarButton key={item.id} item={item} active={false} />
          ))}
        </div>
      </nav>
    </TooltipProvider>
  );
}

function ActivityBarButton({ item, active }: { item: ActivityBarItem; active: boolean }) {
  const trigger = (
    <button
      type="button"
      aria-label={item.label}
      aria-pressed={active || undefined}
      data-testid={`v2-activity-${item.id}`}
      data-active={active ? "true" : undefined}
      onClick={item.onClick}
      className={`relative flex h-9 w-12 shrink-0 items-center justify-center transition-colors hover:text-[var(--fg)] ${
        active ? "text-[var(--fg)]" : "text-[var(--dim)]"
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)]"
        />
      )}
      <item.Icon size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent side="right">{item.tooltip ?? item.label}</TooltipContent>
    </Tooltip>
  );
}
