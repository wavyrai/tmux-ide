/**
 * 28px top bar. Always-visible project name + chevron that opens the
 * Cmd+P quick-switcher. Sits above the IDE shell content so users can
 * see which project they're in without scanning the bottom status bar.
 *
 * Mounted from `/project/:name`. The Cmd+P keybind is already
 * installed at app mount in `ProjectQuickSwitcher`; this bar just
 * supplies a click affordance.
 */

import { Show, type JSX } from "solid-js";
import { ChevronDown, Home } from "lucide-solid";
import { A } from "@solidjs/router";
import { useGitStatus } from "@/lib/git";
import { openProjectQuickSwitcher } from "@/components/projects/ProjectQuickSwitcher";

interface TopBarProps {
  projectName: string;
}

export function TopBar(props: TopBarProps): JSX.Element {
  const status = useGitStatus(() => props.projectName);
  const branch = () => status()?.currentBranch ?? null;
  const dirty = () => {
    const s = status();
    if (!s) return false;
    return s.staged.length > 0 || s.unstaged.length > 0;
  };

  return (
    <div
      data-testid="v2-top-bar"
      class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-2 text-base text-[var(--fg)]"
    >
      <A
        href="/"
        aria-label="Projects home"
        data-testid="v2-top-bar-home"
        class="flex h-5 w-5 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
      >
        <Home size={12} />
      </A>
      <button
        type="button"
        data-testid="v2-top-bar-project"
        onClick={() => openProjectQuickSwitcher()}
        title="Switch project (⌘P)"
        class="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-[var(--surface-hover)]"
      >
        <span class="font-medium" data-testid="v2-top-bar-project-name">
          {props.projectName}
        </span>
        <ChevronDown size={12} class="text-[var(--dim)]" />
      </button>
      <Show when={branch()}>
        <span class="text-[var(--dim)]">·</span>
        <span class="truncate font-mono text-sm text-[var(--dim)]">
          {branch()}
          <Show when={dirty()}>
            <span class="ml-1 text-[var(--accent)]">●</span>
          </Show>
        </span>
      </Show>
      <span class="ml-auto text-xs text-[var(--dim)]">⌘P</span>
    </div>
  );
}
