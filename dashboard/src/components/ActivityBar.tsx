/**
 * V2ActivityBar — Solid port.
 *
 * Vertical 48px bar at the far left of the project IDE shell. Same
 * roster as the React version: top group is the per-view buttons,
 * bottom group is account + settings. Active highlight ties to the
 * current `view` signal; clicking a button calls `onView(id)` which
 * the parent route uses to update the `?view=` search param.
 *
 * Tooltips are intentionally lightweight: a CSS-only `title` attribute
 * on each button instead of the React app's Base UI Tooltip. P2 ships
 * the keyboard-accessible label via `aria-label`; richer floating
 * tooltips can land with the headless-primitive pass in P3.
 */

import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import {
  BookOpen,
  Bot,
  CheckSquare,
  Files,
  GitCompare,
  Grid3X3,
  ListTodo,
  LogOut,
  MessagesSquare,
  Search,
  Settings as SettingsIcon,
  Sliders,
  StickyNote,
  Target,
  Terminal as TerminalIcon,
  UserCircle,
} from "lucide-solid";
import { A } from "@solidjs/router";

type IconComponent = Component<{ size?: number; strokeWidth?: number; class?: string }>;

export type ActivityBarViewId =
  | "files"
  | "search"
  | "diffs"
  | "plans"
  | "tasks"
  | "skills"
  | "notes"
  | "mission"
  | "agents"
  | "chat"
  | "terminal"
  | "widgets";

interface ActivityBarItem {
  id: ActivityBarViewId | "settings" | "account";
  Icon: IconComponent;
  label: string;
  tooltip?: string;
  onClick?: () => void;
  view?: ActivityBarViewId;
}

interface V2ActivityBarProps {
  view: string;
  onView: (id: ActivityBarViewId) => void;
}

export function V2ActivityBar(props: V2ActivityBarProps) {
  const [accountOpen, setAccountOpen] = createSignal(false);
  let accountAnchor!: HTMLDivElement;

  onMount(() => {
    function onPointer(event: PointerEvent) {
      if (!accountOpen()) return;
      if (event.target instanceof Node && accountAnchor.contains(event.target)) return;
      setAccountOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    });
  });

  const top: ActivityBarItem[] = [
    {
      id: "files",
      view: "files",
      Icon: Files,
      label: "files",
      onClick: () => props.onView("files"),
    },
    {
      id: "search",
      view: "search",
      Icon: Search,
      label: "search",
      tooltip: "search · ⇧⌘F",
      onClick: () => props.onView("search"),
    },
    {
      id: "diffs",
      view: "diffs",
      Icon: GitCompare,
      label: "diffs",
      onClick: () => props.onView("diffs"),
    },
    {
      id: "plans",
      view: "plans",
      Icon: ListTodo,
      label: "plans",
      onClick: () => props.onView("plans"),
    },
    {
      id: "tasks",
      view: "tasks",
      Icon: CheckSquare,
      label: "tasks",
      onClick: () => props.onView("tasks"),
    },
    {
      id: "skills",
      view: "skills",
      Icon: BookOpen,
      label: "skills",
      onClick: () => props.onView("skills"),
    },
    {
      id: "notes",
      view: "notes",
      Icon: StickyNote,
      label: "notes",
      onClick: () => props.onView("notes"),
    },
    {
      id: "mission",
      view: "mission",
      Icon: Target,
      label: "mission",
      onClick: () => props.onView("mission"),
    },
    {
      id: "agents",
      view: "agents",
      Icon: Bot,
      label: "agents",
      tooltip: "agents · fleet roster",
      onClick: () => props.onView("agents"),
    },
    {
      id: "chat",
      view: "chat",
      Icon: MessagesSquare,
      label: "chat",
      onClick: () => props.onView("chat"),
    },
    {
      id: "terminal",
      view: "terminal",
      Icon: TerminalIcon,
      label: "terminal",
      onClick: () => props.onView("terminal"),
    },
    {
      id: "widgets",
      Icon: Grid3X3,
      label: "widgets",
      tooltip: "widgets gallery",
      onClick: () => {
        if (typeof window !== "undefined") window.location.assign("/widgets");
      },
    },
  ];

  const bottom: ActivityBarItem[] = [
    {
      id: "account",
      Icon: UserCircle,
      label: "account",
      tooltip: "account · sign out",
      onClick: () => setAccountOpen((v) => !v),
    },
    {
      id: "settings",
      Icon: SettingsIcon,
      label: "settings",
      tooltip: "settings · theme · keybinds",
      onClick: () => {
        if (typeof window !== "undefined") window.location.assign("/settings");
      },
    },
  ];

  return (
    <nav
      aria-label="Activity bar"
      data-testid="v2-activity-bar"
      class="flex h-full w-12 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-weak)]"
    >
      <div class="flex flex-col">
        <For each={top}>
          {(item) => (
            <ActivityBarButton
              item={item}
              active={item.view !== undefined && item.view === props.view}
            />
          )}
        </For>
      </div>
      <div class="flex-1" />
      <div ref={accountAnchor} class="relative flex flex-col">
        <For each={bottom}>{(item) => <ActivityBarButton item={item} active={false} />}</For>
        <Show when={accountOpen()}>
          <AccountPopover onClose={() => setAccountOpen(false)} />
        </Show>
      </div>
    </nav>
  );
}

function AccountPopover(props: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Account"
      data-testid="v2-account-popover"
      class="absolute bottom-1 left-[calc(100%+0.5rem)] z-50 w-56 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-base">
        <UserCircle size={16} aria-hidden="true" class="text-[var(--accent)]" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[var(--fg)]">Local user</div>
          <div class="truncate text-xs text-[var(--dim)]">
            tmux-ide runs locally — no auth wired yet
          </div>
        </div>
      </div>
      <ul class="m-0 list-none p-1">
        <li>
          <A
            href="/settings"
            data-testid="v2-account-popover-settings"
            onClick={() => props.onClose()}
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-base text-[var(--fg)] hover:bg-[var(--surface-hover)]"
          >
            <Sliders size={12} aria-hidden="true" />
            <span>Preferences</span>
          </A>
        </li>
        <li>
          <button
            type="button"
            data-testid="v2-account-popover-signout"
            onClick={() => props.onClose()}
            disabled
            class="flex w-full items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-[var(--dim)] disabled:cursor-not-allowed"
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

function ActivityBarButton(props: { item: ActivityBarItem; active: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.item.label}
      aria-pressed={props.active || undefined}
      data-testid={`v2-activity-${props.item.id}`}
      data-active={props.active ? "true" : undefined}
      title={props.item.tooltip ?? props.item.label}
      onClick={props.item.onClick}
      class={`relative flex h-9 w-12 shrink-0 items-center justify-center transition-colors hover:text-[var(--fg)] ${
        props.active ? "text-[var(--fg)]" : "text-[var(--dim)]"
      }`}
    >
      <Show when={props.active}>
        <span
          aria-hidden="true"
          class="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)]"
        />
      </Show>
      <props.item.Icon size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
