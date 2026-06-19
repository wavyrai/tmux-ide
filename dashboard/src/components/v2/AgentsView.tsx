/**
 * AgentsView — fleet-wide agent roster.
 *
 * A single read-only surface that lists every Claude/codex agent across
 * all machines so the user sees their laptop + remote (SSM) boxes and
 * their sessions in one place.
 *
 * Data flows from `GET /api/hq/agents` (aggregated across machines),
 * falling back to `GET /api/agents` (this host only) when HQ 404s. The
 * AgentRecord shape comes straight from @tmux-ide/contracts — agents are
 * grouped by machine, then by session (tmux) vs "external".
 *
 * Observe-only for now: no actions. Matches the MissionStatementView
 * polling / Tailwind conventions used by the other v2 views.
 */

import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Bot } from "lucide-solid";
import type { AgentRecord } from "@tmux-ide/contracts";
import { API_BASE } from "@/lib/api";

interface AgentsViewProps {
  projectName: string;
}

const STATUS_COLOR: Record<AgentRecord["status"], string> = {
  busy: "var(--yellow)",
  idle: "var(--green)",
  offline: "var(--dim)",
};

const KIND_LABEL: Record<AgentRecord["kind"], string> = {
  managed: "managed",
  "tmux-unmanaged": "unmanaged",
  external: "external",
};

type LoadState = "loading" | "ready" | "error";

const THIS_MACHINE = "This machine";
const EXTERNAL_GROUP = "external";

/**
 * Polls the fleet roster every `intervalMs` (default 4 s). Prefers
 * `/api/hq/agents`; on a 404 it falls back to `/api/agents` (this host)
 * and remembers the fallback so subsequent ticks skip the HQ probe.
 */
function createAgentsPoll(intervalMs = 4000): {
  agents: () => AgentRecord[];
  state: () => LoadState;
  error: () => string | null;
} {
  const [agents, setAgents] = createSignal<AgentRecord[]>([]);
  const [state, setState] = createSignal<LoadState>("loading");
  const [error, setError] = createSignal<string | null>(null);

  let cancelled = false;
  let useFallback = false;

  async function fetchFrom(path: string): Promise<AgentRecord[] | "missing" | "error"> {
    try {
      const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
      if (res.status === 404) return "missing";
      if (!res.ok) return "error";
      const body = (await res.json()) as { agents?: AgentRecord[] };
      return body.agents ?? [];
    } catch {
      return "error";
    }
  }

  async function tick(): Promise<void> {
    let result = useFallback ? "missing" : await fetchFrom("/api/hq/agents");
    if (result === "missing") {
      useFallback = true;
      result = await fetchFrom("/api/agents");
    }
    if (cancelled) return;
    if (result === "missing" || result === "error") {
      // Only surface the error banner when we have nothing to show; a
      // transient blip while data is already on screen stays quiet.
      setState((prev) => (prev === "ready" ? "ready" : "error"));
      if (state() !== "ready") setError("Couldn't reach the agents API");
      return;
    }
    setAgents(result);
    setError(null);
    setState("ready");
  }

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  onCleanup(() => {
    cancelled = true;
    clearInterval(timer);
  });

  return { agents, state, error };
}

interface MachineGroup {
  machineName: string;
  agents: AgentRecord[];
  sessions: SessionGroup[];
}

interface SessionGroup {
  key: string;
  label: string;
  isExternal: boolean;
  agents: AgentRecord[];
}

function groupByMachine(agents: AgentRecord[]): MachineGroup[] {
  const byMachine = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    const machine = agent.machineName ?? THIS_MACHINE;
    const list = byMachine.get(machine);
    if (list) list.push(agent);
    else byMachine.set(machine, [agent]);
  }

  const machines: MachineGroup[] = [];
  for (const [machineName, machineAgents] of byMachine) {
    const bySession = new Map<string, SessionGroup>();
    for (const agent of machineAgents) {
      const isExternal = agent.kind === "external";
      const key = isExternal ? EXTERNAL_GROUP : (agent.session ?? EXTERNAL_GROUP);
      const label = isExternal ? "external" : (agent.session ?? "external");
      const group = bySession.get(key);
      if (group) group.agents.push(agent);
      else bySession.set(key, { key, label, isExternal, agents: [agent] });
    }
    machines.push({
      machineName,
      agents: machineAgents,
      // External sessions sink to the bottom; named sessions sort alpha.
      sessions: [...bySession.values()].sort((a, b) => {
        if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1;
        return a.label.localeCompare(b.label);
      }),
    });
  }

  // "This machine" first, then the rest alphabetically.
  return machines.sort((a, b) => {
    if (a.machineName === THIS_MACHINE) return -1;
    if (b.machineName === THIS_MACHINE) return 1;
    return a.machineName.localeCompare(b.machineName);
  });
}

export function AgentsView(_props: AgentsViewProps): JSX.Element {
  const { agents, state, error } = createAgentsPoll();

  const machines = createMemo(() => groupByMachine(agents()));
  const busyCount = createMemo(() => agents().filter((a) => a.status === "busy").length);

  return (
    <div
      data-testid="agents-view"
      class="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--bg)] text-[var(--fg)]"
      style={{ "font-family": "var(--font-mono)", "font-size": "var(--text-base)" }}
    >
      <Header total={agents().length} busy={busyCount()} machines={machines().length} />

      <Show
        when={state() !== "loading"}
        fallback={
          <div
            data-testid="agents-loading"
            class="flex flex-1 items-center justify-center gap-3 p-8 text-[var(--dim)]"
          >
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
            <span>Loading agents…</span>
          </div>
        }
      >
        <Show
          when={!(state() === "error" && agents().length === 0)}
          fallback={
            <div
              data-testid="agents-error"
              class="flex flex-1 items-center justify-center p-8 text-center text-[var(--red,#cc6666)]"
            >
              {error() ?? "Couldn't reach the agents API"}
            </div>
          }
        >
          <Show
            when={agents().length > 0}
            fallback={
              <div
                data-testid="agents-empty"
                class="flex flex-1 items-center justify-center p-8 text-center text-[var(--dim)]"
              >
                No agents online.
              </div>
            }
          >
            <div class="flex flex-col gap-4 p-4">
              <For each={machines()}>{(machine) => <MachineSection group={machine} />}</For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function Header(props: { total: number; busy: number; machines: number }): JSX.Element {
  return (
    <header class="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-strong,var(--bg))] px-4 py-3">
      <Bot size={16} strokeWidth={1.75} aria-hidden="true" class="text-[var(--accent)]" />
      <span class="font-medium text-[var(--fg)]">Agents</span>
      <span class="ml-auto flex items-center gap-3 text-sm tabular-nums text-[var(--dim)]">
        <span data-testid="agents-summary-total">
          {props.total} {props.total === 1 ? "agent" : "agents"}
        </span>
        <span data-testid="agents-summary-busy">{props.busy} busy</span>
        <span data-testid="agents-summary-machines">
          {props.machines} {props.machines === 1 ? "machine" : "machines"}
        </span>
      </span>
    </header>
  );
}

function MachineSection(props: { group: MachineGroup }): JSX.Element {
  return (
    <section
      data-agents-machine={props.group.machineName}
      class="rounded-md border border-[var(--border)] bg-[var(--surface)]"
    >
      <div class="flex items-center gap-2 border-b border-[var(--border-weak,var(--border))] px-3 py-2">
        <span aria-hidden="true" class="text-[var(--dim)]">
          ▣
        </span>
        <span class="font-medium text-[var(--fg)]">{props.group.machineName}</span>
        <span class="ml-auto text-sm tabular-nums text-[var(--dim)]">
          {props.group.agents.length}
        </span>
      </div>
      <div class="flex flex-col gap-3 p-3">
        <For each={props.group.sessions}>{(session) => <SessionBlock group={session} />}</For>
      </div>
    </section>
  );
}

function SessionBlock(props: { group: SessionGroup }): JSX.Element {
  return (
    <div data-agents-session={props.group.key}>
      <div class="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--dim)]">
        <span aria-hidden="true">{props.group.isExternal ? "◇" : "⊟"}</span>
        <span>{props.group.label}</span>
      </div>
      <div class="flex flex-col gap-1">
        <For each={props.group.agents}>{(agent) => <AgentRow agent={agent} />}</For>
      </div>
    </div>
  );
}

function AgentRow(props: { agent: AgentRecord }): JSX.Element {
  const agent = () => props.agent;
  const subtitle = createMemo(() => {
    const a = agent();
    if (a.session && a.paneTitle) return `${a.session} · ${a.paneTitle}`;
    if (a.paneTitle) return a.paneTitle;
    return a.cwd ?? null;
  });

  return (
    <div
      data-agents-row={agent().id}
      data-agents-status={agent().status}
      class="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-strong,var(--surface))] px-2 py-1.5"
    >
      <StatusDot status={agent().status} />
      <span
        class="rounded border border-[var(--border)] px-1 text-xs uppercase tracking-wider text-[var(--fg-secondary)]"
        title={`tool: ${agent().tool}`}
      >
        {agent().tool}
      </span>
      <span class="truncate font-medium text-[var(--fg)]">{agent().name}</span>
      <Show when={subtitle()}>
        <span class="truncate text-sm text-[var(--dim)]">{subtitle()}</span>
      </Show>
      <Show when={agent().taskTitle}>
        {(title) => (
          <span
            class="truncate rounded border-l-2 border-[var(--accent)] bg-[var(--surface)] px-1.5 text-sm text-[var(--fg-secondary)]"
            title={title()}
          >
            {title()}
          </span>
        )}
      </Show>
      <span
        class="ml-auto shrink-0 rounded-full border px-2 py-[1px] text-xs uppercase tracking-wider text-[var(--dim)]"
        style={{ "border-color": "var(--border)" }}
        title={`kind: ${agent().kind}`}
      >
        {KIND_LABEL[agent().kind]}
      </span>
    </div>
  );
}

function StatusDot(props: { status: AgentRecord["status"] }): JSX.Element {
  return (
    <span
      aria-label={props.status}
      class={
        "inline-block h-2 w-2 shrink-0 rounded-full " +
        (props.status === "busy" ? "animate-pulse" : "")
      }
      style={{ background: STATUS_COLOR[props.status] }}
    />
  );
}
