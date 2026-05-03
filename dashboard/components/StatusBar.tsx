"use client";

import { usePathname } from "next/navigation";
import { AgentsSegment } from "@/components/status-bar/AgentsSegment";
import { MilestonesSegment } from "@/components/status-bar/MilestonesSegment";
import { MissionStatusSegment } from "@/components/status-bar/MissionStatusSegment";
import { projectNameFromPath } from "@/components/status-bar/projectPath";
import { SkillsSegment } from "@/components/status-bar/SkillsSegment";
import type { ProjectDetail } from "@/lib/types";

interface StatusBarProps {
  project: ProjectDetail;
  lastUpdate?: number;
  stale?: boolean;
}

function projectFromPath(pathname: string): string {
  return projectNameFromPath(pathname) ?? "overview";
}

export function ShellStatusBar() {
  const pathname = usePathname();
  const project = projectFromPath(pathname);
  const projectRoute = projectNameFromPath(pathname) !== null;
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

  return (
    <footer
      data-testid="status-bar"
      className="flex h-6 shrink-0 items-center overflow-hidden border-t border-[var(--border-weak)] bg-[var(--bg-weak)] px-2 text-[10px] tabular-nums text-[var(--dim)] md:px-3 md:text-[11px]"
    >
      <span className="truncate text-[var(--accent)]">{project}</span>
      {projectRoute && (
        <>
          <MissionStatusSegment />
          <span className="hidden md:contents">
            <MilestonesSegment />
          </span>
          <AgentsSegment />
          <span className="hidden md:contents">
            <SkillsSegment />
          </span>
        </>
      )}
      <span className="mx-1 opacity-30 md:mx-2">│</span>
      <span className="hidden sm:inline">terminal ⌘J</span>
      <span className="mx-1 hidden opacity-30 sm:inline md:mx-2">│</span>
      <span className="hidden sm:inline">theme ⌘⇧T</span>
      <span className="flex-1" />
      <span className="shrink-0">tmux-ide {version}</span>
    </footer>
  );
}

export function StatusBar(_props: StatusBarProps) {
  return null;
}
