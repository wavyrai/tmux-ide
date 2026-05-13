/**
 * StatusBar — 24px bottom footer. Slim Solid port focused on the
 * affordances the G16-P2 shell actually exposes: project name + run
 * indicator, agent count placeholder, chrome toggles (Cmd+B / Cmd+J /
 * Cmd+Alt+B). Branch lookup + latest-event readout will land alongside
 * the polling/SSE port in G16-P3.
 */

import { createSignal, Show, type Component } from "solid-js";
import { GitBranch, PanelLeft, PanelBottom, PanelRight } from "lucide-solid";
import {
  chrome,
  toggleBottomPanel,
  toggleLeftSidebar,
  toggleRightInspector,
} from "@/lib/chrome";
import { useGitStatus } from "@/lib/git";
import { BranchPicker } from "@/components/BranchPicker";
import { PushButton } from "@/components/PushButton";

type IconComponent = Component<{ size?: number; class?: string }>;

interface StatusBarProps {
  projectName: string;
  running: boolean;
  agentCount: number;
  bottomPanelUnread?: number;
}

export function StatusBar(props: StatusBarProps) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | undefined>();
  const status = useGitStatus(() => props.projectName);
  const branch = () => status()?.currentBranch ?? null;
  const ahead = () => status()?.ahead ?? 0;
  const behind = () => status()?.behind ?? 0;
  const dirty = () => {
    const s = status();
    if (!s) return false;
    return s.staged.length > 0 || s.unstaged.length > 0;
  };

  function openPicker(e: MouseEvent) {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setAnchor({ x: rect.left, y: rect.top });
    setPickerOpen(true);
  }

  return (
    <footer
      data-testid="v2-status-bar"
      style={{ height: "24px" }}
      class="flex shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-strong)] px-3 text-[11px] text-[var(--fg-muted,var(--fg-secondary))]"
    >
      <button
        type="button"
        data-testid="status-bar-branch"
        onClick={openPicker}
        title={branch() ? `On branch ${branch()} — click to switch` : "Click to pick a branch"}
        class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.08))] hover:text-[var(--fg)]"
      >
        <GitBranch aria-hidden="true" size={12} />
        <span data-testid="status-bar-branch-name">{branch() ?? "—"}</span>
        <Show when={dirty()}>
          <span aria-hidden="true" class="text-[var(--accent)]" title="Uncommitted changes">●</span>
        </Show>
        <Show when={ahead() > 0}>
          <span class="text-[10px] tabular-nums">↑{ahead()}</span>
        </Show>
        <Show when={behind() > 0}>
          <span class="text-[10px] tabular-nums">↓{behind()}</span>
        </Show>
      </button>
      <BranchPicker
        sessionName={props.projectName}
        open={pickerOpen()}
        onClose={() => setPickerOpen(false)}
        anchor={anchor()}
        onCheckedOut={() => {
          status.refetch();
        }}
      />
      <PushButton
        sessionName={props.projectName}
        ahead={ahead()}
        onPushed={() => status.refetch()}
      />

      <span aria-hidden="true" class="opacity-30">│</span>

      <span
        data-testid="status-bar-session"
        class="inline-flex items-center gap-1"
        title={props.running ? "Project session is running" : "Project session is stopped"}
      >
        <span
          aria-hidden="true"
          style={{ color: props.running ? "var(--accent)" : "var(--dim)" }}
        >
          ●
        </span>
        <span>{props.projectName}</span>
      </span>

      <span aria-hidden="true" class="opacity-30">│</span>

      <span data-testid="status-bar-agents" title="Active agent panes">
        {props.agentCount} {props.agentCount === 1 ? "agent" : "agents"}
      </span>

      <span class="flex-1" />

      <ChromeToggle
        icon={PanelLeft}
        active={chrome().leftSidebarOpen}
        onClick={toggleLeftSidebar}
        ariaLabel="Toggle Primary Sidebar"
        title="Toggle Primary Sidebar (⌘B)"
        testId="status-bar-toggle-left"
      />
      <ChromeToggle
        icon={PanelBottom}
        active={chrome().bottomPanelOpen}
        onClick={toggleBottomPanel}
        ariaLabel="Toggle Panel"
        title="Toggle Panel (⌘J)"
        testId="status-bar-toggle-bottom"
        badge={!chrome().bottomPanelOpen ? (props.bottomPanelUnread ?? 0) : 0}
      />
      <ChromeToggle
        icon={PanelRight}
        active={chrome().rightInspectorOpen}
        onClick={toggleRightInspector}
        ariaLabel="Toggle Secondary Sidebar"
        title="Toggle Secondary Sidebar (⌘⌥B)"
        testId="status-bar-toggle-right"
      />
    </footer>
  );
}

interface ChromeToggleProps {
  icon: IconComponent;
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  testId: string;
  badge?: number;
}

function ChromeToggle(props: ChromeToggleProps) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      data-testid={props.testId}
      data-active={props.active ? "true" : "false"}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      aria-pressed={props.active}
      title={props.title}
      class={
        "relative inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)] " +
        (props.active ? "text-[var(--fg)]" : "text-[var(--dim)]")
      }
    >
      <Icon aria-hidden="true" size={14} />
      <Show when={(props.badge ?? 0) > 0}>
        <span
          aria-hidden="true"
          data-testid={`${props.testId}-badge`}
          class="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-[var(--red,var(--accent))] px-1 text-[9px] font-medium text-white"
        >
          {(props.badge ?? 0) > 9 ? "9+" : props.badge}
        </span>
      </Show>
    </button>
  );
}
