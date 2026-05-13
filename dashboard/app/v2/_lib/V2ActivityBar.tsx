"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Files,
  Search,
  GitCompare,
  Grid3X3,
  ListTodo,
  CheckSquare,
  Target,
  MessagesSquare,
  Terminal as TerminalIcon,
  BookOpen,
  LogOut,
  UserCircle,
  Settings as SettingsIcon,
  Sliders,
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
  | "skills"
  | "mission"
  | "chat"
  | "terminal"
  | "widgets";

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
  const [accountOpen, setAccountOpen] = useState(false);
  const accountAnchorRef = useRef<HTMLDivElement | null>(null);

  // Close the Account popover on outside click + Escape — same pattern
  // the rest of the v2 popovers (chat provider picker, command-palette)
  // use. Listeners attach only while open to keep the bar cheap when
  // nobody's interacting with it.
  useEffect(() => {
    if (!accountOpen) return;
    function onPointer(event: PointerEvent) {
      const root = accountAnchorRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setAccountOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);
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
      id: "skills",
      view: "skills",
      Icon: BookOpen,
      label: "Skills",
      onClick: () => onView("skills"),
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
    {
      id: "widgets",
      Icon: Grid3X3,
      label: "Widgets",
      tooltip: "Widgets gallery",
      // The gallery is a standalone top-level route (/v2/widgets), not
      // a project-scoped view, so we navigate the browser rather than
      // switching the project page's view state. Activity-bar items
      // already allow free-form onClick, so this stays consistent with
      // the existing Search entry's openCommandPalette pattern.
      onClick: () => {
        if (typeof window !== "undefined") window.location.assign("/v2/widgets");
      },
    },
  ];

  const bottom: ActivityBarItem[] = [
    {
      id: "account",
      Icon: UserCircle,
      label: "Account",
      tooltip: "Account · Sign out",
      onClick: () => setAccountOpen((v) => !v),
    },
    {
      id: "settings",
      Icon: SettingsIcon,
      label: "Settings",
      tooltip: "Settings · Theme · Keybinds",
      // /v2/settings is a standalone top-level route; navigate the
      // browser rather than switching the project page's view state.
      // Same pattern the Widgets entry uses above.
      onClick: () => {
        if (typeof window !== "undefined") window.location.assign("/v2/settings");
      },
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
        <div ref={accountAnchorRef} className="relative flex flex-col">
          {bottom.map((item) => (
            <ActivityBarButton key={item.id} item={item} active={false} />
          ))}
          {accountOpen && <AccountPopover onClose={() => setAccountOpen(false)} />}
        </div>
      </nav>
    </TooltipProvider>
  );
}

function AccountPopover({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Account"
      data-testid="v2-account-popover"
      className="absolute bottom-1 left-[calc(100%+0.5rem)] z-50 w-56 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[12px]">
        <UserCircle size={16} aria-hidden="true" className="text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[var(--fg)]">Local user</div>
          <div className="truncate text-[10px] text-[var(--dim)]">
            tmux-ide runs locally — no auth wired yet
          </div>
        </div>
      </div>
      <ul className="m-0 list-none p-1">
        <li>
          <Link
            href="/v2/settings"
            data-testid="v2-account-popover-settings"
            onClick={onClose}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
          >
            <Sliders size={12} aria-hidden="true" />
            <span>Preferences</span>
          </Link>
        </li>
        <li>
          <button
            type="button"
            data-testid="v2-account-popover-signout"
            onClick={onClose}
            disabled
            className="flex w-full items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-[var(--dim)] disabled:cursor-not-allowed"
            title="Sign-out is not wired — tmux-ide runs locally"
          >
            <LogOut size={12} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </li>
      </ul>
    </div>
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
