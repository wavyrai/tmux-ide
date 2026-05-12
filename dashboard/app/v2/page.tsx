"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Panel, Group } from "react-resizable-panels";
import { VSeparator, HSeparator } from "./_lib/Separators";
import { fetchSessions } from "@/lib/api";
import { useProjects } from "@/lib/projectStore";
import type { SessionOverview } from "@/lib/types";
import { useStoredLayout } from "./_lib/useStoredLayout";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MainTabsBar } from "@/components/MainTabsBar";
import { openCommandPalette } from "@/components/CommandPalette";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { TopBarActionButton, TopBarSeparator } from "./_lib/TopBarActionButton";
import { Badge, Card, DataTable, RowSpaceBetween } from "@/components/v2-primitives";

export default function V2OverviewPage() {
  const { projects, loading: projectsLoading, error: projectsError } = useProjects();
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(false);
  const [time, setTime] = useState("");

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await fetchSessions();
        if (!active) return;
        setSessions(data);
        setSessionsError(false);
      } catch {
        if (!active) return;
        setSessionsError(true);
      } finally {
        if (active) setSessionsLoading(false);
      }
    }
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    function tick() {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  const merged = useMemo(() => mergeProjectsAndSessions(projects, sessions), [projects, sessions]);
  const runningCount = merged.filter((m) => m.session !== null).length;
  const apiUnreachable = sessionsError && projectsError;
  const [hLayout, setHLayout] = useStoredLayout("overview-h");
  const [vLayout, setVLayout] = useStoredLayout("overview-v");

  return (
    <div className="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <TooltipProvider delay={200}>
        <header className="flex h-7 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-strong)] pl-3 text-[11px] tabular-nums">
          <Link
            href="/v2"
            className="mr-2 inline-flex items-center gap-1 text-[var(--fg)] hover:text-[var(--accent)]"
          >
            <span aria-hidden="true">◇</span>
            <span className="font-medium">tmux-ide</span>
          </Link>
          <span className="mx-1 text-[var(--dimmer)]">·</span>
          <span className="text-[var(--accent)]">overview</span>
          <span className="flex-1" />
          <span className="mr-3 text-[var(--dim)]">{time}</span>
          <TopBarSeparator />
          <TopBarActionButton
            icon="⌕"
            tooltip="Search · ⌘K"
            ariaLabel="Search"
            onClick={openCommandPalette}
            testId="v2-topbar-find"
          />
          <TopBarActionButton
            icon="⌘"
            tooltip="Command palette · ⌘K"
            ariaLabel="Command palette"
            onClick={openCommandPalette}
            testId="v2-topbar-palette"
          />
          <ThemeToggle />
        </header>
      </TooltipProvider>

      <MainTabsBar />

      <div className="flex-1 min-h-0">
        <Group orientation="horizontal" defaultLayout={hLayout} onLayoutChange={setHLayout}>
          <Panel
            id="sidebar"
            defaultSize={20}
            minSize={14}
            collapsible
            collapsedSize={4}
            className="border-r border-[var(--border)]"
          >
            <SidebarPane
              merged={merged}
              loading={projectsLoading || sessionsLoading}
              error={apiUnreachable}
            />
          </Panel>

          <VSeparator />

          <Panel id="center" defaultSize={56} minSize={30}>
            <Group orientation="vertical" defaultLayout={vLayout} onLayoutChange={setVLayout}>
              <Panel id="main" defaultSize={70} minSize={20}>
                <MainPane
                  merged={merged}
                  loading={projectsLoading || sessionsLoading}
                  error={apiUnreachable}
                />
              </Panel>

              <HSeparator />

              <Panel id="terminal" defaultSize={30} minSize={10}>
                <TerminalPane runningCount={runningCount} />
              </Panel>
            </Group>
          </Panel>

          <VSeparator />

          <Panel
            id="inspector"
            defaultSize={24}
            minSize={12}
            collapsible
            collapsedSize={4}
            className="border-l border-[var(--border)]"
          >
            <InspectorPane merged={merged} apiUnreachable={apiUnreachable} />
          </Panel>
        </Group>
      </div>

      <footer className="flex h-6 shrink-0 items-center border-t border-[var(--border)] bg-[var(--bg-strong)] px-3 text-[10px] tabular-nums text-[var(--dim)]">
        <Tooltip>
          <TooltipTrigger render={<span className="text-[var(--accent)]">overview</span>} />
          <TooltipContent side="top">Active view</TooltipContent>
        </Tooltip>
        <span className="mx-2 opacity-30">│</span>
        <Tooltip>
          <TooltipTrigger render={<span>{merged.length} projects</span>} />
          <TooltipContent side="top">Registered + discovered projects</TooltipContent>
        </Tooltip>
        <span className="mx-2 opacity-30">│</span>
        <Tooltip>
          <TooltipTrigger render={<span>{runningCount} running</span>} />
          <TooltipContent side="top">Projects with a live tmux session</TooltipContent>
        </Tooltip>
        {apiUnreachable && (
          <>
            <span className="mx-2 opacity-30">│</span>
            <Tooltip>
              <TooltipTrigger render={<span className="text-[var(--red)]">api unreachable</span>} />
              <TooltipContent side="top">command-center is not responding</TooltipContent>
            </Tooltip>
          </>
        )}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="border border-[var(--border-weak)] px-1.5 text-[var(--fg-secondary)]">
                v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
              </span>
            }
          />
          <TooltipContent side="top">
            tmux-ide v2 · build {process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
          </TooltipContent>
        </Tooltip>
      </footer>
    </div>
  );
}

// ---------------- merge helper ----------------

interface MergedProject {
  name: string;
  dir: string | null;
  registered: boolean;
  session: SessionOverview | null;
}

function mergeProjectsAndSessions(
  projects: ReadonlyArray<{ name: string; dir: string }>,
  sessions: ReadonlyArray<SessionOverview>,
): MergedProject[] {
  const byName = new Map<string, MergedProject>();
  for (const session of sessions) {
    byName.set(session.name, {
      name: session.name,
      dir: session.dir,
      registered: false,
      session,
    });
  }
  for (const project of projects) {
    const existing = byName.get(project.name);
    if (existing) {
      existing.registered = true;
    } else {
      byName.set(project.name, {
        name: project.name,
        dir: project.dir,
        registered: true,
        session: null,
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------- panes ----------------

interface SidebarPaneProps {
  merged: MergedProject[];
  loading: boolean;
  error: boolean;
}

function SidebarPane({ merged, loading, error }: SidebarPaneProps) {
  const rowCls =
    "flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]";
  const rowStyle: React.CSSProperties = { borderLeft: "2px solid transparent" };
  return (
    <nav className="flex h-full flex-col overflow-y-auto py-2 text-[12px]">
      <div className="mb-1 px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        projects
      </div>
      {error ? (
        <div className="px-3 py-1 text-[10px] text-[var(--red)]">api unreachable</div>
      ) : loading && merged.length === 0 ? (
        <div className="px-3 py-1 text-[10px] text-[var(--dim)]">loading…</div>
      ) : merged.length === 0 ? (
        <div className="px-3 py-1 text-[10px] text-[var(--dim)]">no projects yet</div>
      ) : (
        merged.map((p) => (
          <Link
            key={p.name}
            href={`/v2/project/${encodeURIComponent(p.name)}`}
            style={rowStyle}
            className={`${rowCls} text-[var(--fg)]`}
          >
            <span
              aria-hidden="true"
              className={`w-4 text-center ${p.session ? "text-[var(--green)]" : "text-[var(--dim)]"}`}
            >
              {p.session ? "●" : "○"}
            </span>
            <span className="truncate">{p.name}</span>
          </Link>
        ))
      )}

      <Link
        href="/"
        style={rowStyle}
        className={`${rowCls} text-[var(--dim)] hover:text-[var(--fg)]`}
      >
        <span aria-hidden="true" className="w-4 text-center">
          ◂
        </span>
        <span>Old dashboard</span>
      </Link>
    </nav>
  );
}

interface MainPaneProps {
  merged: MergedProject[];
  loading: boolean;
  error: boolean;
}

function MainPane({ merged, loading, error }: MainPaneProps) {
  const tableData = useMemo<string[][]>(() => {
    const head = ["NAME", "STATUS", "MISSION", "TASKS"];
    if (error) return [head, ["—", "api unreachable", "—", "—"]];
    if (loading && merged.length === 0) return [head, ["…", "loading", "—", "—"]];
    if (merged.length === 0) return [head, ["—", "no projects yet", "—", "—"]];
    const body = merged.map((p) => [
      p.name,
      p.session ? "running" : "stopped",
      p.session?.mission?.title ?? "—",
      p.session?.stats ? `${p.session.stats.doneTasks}/${p.session.stats.totalTasks}` : "—",
    ]);
    return [head, ...body];
  }, [merged, loading, error]);

  return (
    <div className="h-full overflow-y-auto p-3">
      <Card title="ACTIVE SESSIONS" mode="left">
        <DataTable data={tableData} />
      </Card>

      <br />

      <Card title="MIGRATION PROGRESS — V2 SHELL" mode="left">
        <RowSpaceBetween>
          <span>v2 overview</span>
          <Badge>live</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>v2 project view</span>
          <Badge>live</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>v2 terminal route</span>
          <Badge>todo</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>token bridge</span>
          <Badge>live</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>lucide swap</span>
          <Badge>~12 of ~44</Badge>
        </RowSpaceBetween>
      </Card>
    </div>
  );
}

function TerminalPane({ runningCount }: { runningCount: number }) {
  return (
    <div className="h-full overflow-hidden bg-[var(--bg-strong)] p-3 text-[11px] leading-tight">
      <div className="mb-2 flex items-center text-[10px] text-[var(--dim)]">
        <span aria-hidden="true" className="mr-1">
          {">_"}
        </span>
        <span>terminal · v2 overview</span>
      </div>
      <pre className="whitespace-pre-wrap text-[var(--fg)]">
        {`$ tmux-ide ls
${runningCount === 0 ? "no sessions running" : `${runningCount} session${runningCount === 1 ? "" : "s"} running`}
$ █`}
      </pre>
    </div>
  );
}

interface InspectorPaneProps {
  merged: MergedProject[];
  apiUnreachable: boolean;
}

function InspectorPane({ merged, apiUnreachable }: InspectorPaneProps) {
  const totalAgents = merged.reduce((acc, p) => acc + (p.session?.stats.agents ?? 0), 0);
  const activeAgents = merged.reduce((acc, p) => acc + (p.session?.stats.activeAgents ?? 0), 0);
  const totalTasks = merged.reduce((acc, p) => acc + (p.session?.stats.totalTasks ?? 0), 0);
  const doneTasks = merged.reduce((acc, p) => acc + (p.session?.stats.doneTasks ?? 0), 0);

  return (
    <aside className="flex h-full flex-col overflow-y-auto p-3 text-[12px]">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">inspector</div>
      <Card title="AGENTS" mode="left">
        {apiUnreachable ? (
          <p className="text-[var(--dim)]">api unreachable</p>
        ) : (
          <>
            <RowSpaceBetween>
              <span>Total</span>
              <Badge>{totalAgents}</Badge>
            </RowSpaceBetween>
            <RowSpaceBetween>
              <span>Active</span>
              <Badge>{activeAgents}</Badge>
            </RowSpaceBetween>
          </>
        )}
      </Card>
      <br />
      <Card title="TASKS" mode="left">
        {apiUnreachable ? (
          <p className="text-[var(--dim)]">api unreachable</p>
        ) : (
          <>
            <RowSpaceBetween>
              <span>Total</span>
              <Badge>{totalTasks}</Badge>
            </RowSpaceBetween>
            <RowSpaceBetween>
              <span>Done</span>
              <Badge>{doneTasks}</Badge>
            </RowSpaceBetween>
          </>
        )}
      </Card>
      <br />
      <Card title="HOTKEYS" mode="left">
        <div className="space-y-1 text-[var(--dim)]">
          <div>
            <kbd className="text-[var(--fg)]">⌘K</kbd> command palette
          </div>
          <div>
            <kbd className="text-[var(--fg)]">⌘J</kbd> toggle terminal
          </div>
          <div>
            <kbd className="text-[var(--fg)]">⌘\</kbd> toggle sidebar
          </div>
        </div>
      </Card>
    </aside>
  );
}
