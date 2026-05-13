/**
 * CheckRunsRail — CI/CD strip at the top of the Diffs view (G18-P3).
 *
 * Shows the latest commit's check runs as chips: status icon + name +
 * source app, with a click-through to the run's logs URL on github.com.
 * No GitHub remote / no checks → empty-state collapse so the rail
 * doesn't take vertical space on local-only repos.
 *
 * Data: `/api/project/:name/git/checks?ref=<sha?>` — the daemon
 * resolves the ref (defaults to HEAD) and delegates to `gh api` so we
 * inherit the user's auth.
 */

import { createMemo, For, Show } from "solid-js";
import {
  CheckCircle2,
  Clock,
  HelpCircle,
  Loader2,
  XCircle,
  MinusCircle,
} from "lucide-solid";
import type { CheckRun } from "@tmux-ide/contracts";
import { useChecks } from "@/lib/git";

interface CheckRunsRailProps {
  sessionName: string;
  /** Optional ref override. Defaults to HEAD (daemon resolves). */
  ref?: string | null;
}

function chipTone(run: CheckRun): {
  Icon: typeof CheckCircle2;
  color: string;
  label: string;
} {
  if (run.status !== "completed") {
    return { Icon: Loader2, color: "var(--dim)", label: "running" };
  }
  switch (run.conclusion) {
    case "success":
      return { Icon: CheckCircle2, color: "var(--accent)", label: "passed" };
    case "failure":
    case "timed_out":
    case "action_required":
      return { Icon: XCircle, color: "var(--danger,#d34)", label: run.conclusion };
    case "cancelled":
    case "stale":
      return { Icon: MinusCircle, color: "var(--dim)", label: run.conclusion };
    case "neutral":
      return { Icon: HelpCircle, color: "var(--dim)", label: "neutral" };
    case "skipped":
      return { Icon: Clock, color: "var(--dim)", label: "skipped" };
    default:
      return { Icon: HelpCircle, color: "var(--dim)", label: "unknown" };
  }
}

export function CheckRunsRail(props: CheckRunsRailProps) {
  const resource = useChecks(
    () => props.sessionName,
    () => props.ref ?? null,
  );

  const summary = createMemo(() => resource()?.summary ?? null);
  const runs = createMemo<CheckRun[]>(() => resource()?.runs ?? []);
  const hasContent = createMemo(() => runs().length > 0 || resource.loading);

  return (
    <Show when={hasContent()}>
      <section
        data-testid="check-runs-rail"
        data-status={
          summary()?.failed && summary()!.failed > 0
            ? "failed"
            : summary()?.pending && summary()!.pending > 0
              ? "pending"
              : summary() && summary()!.passed === summary()!.total
                ? "passed"
                : "neutral"
        }
        class="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 py-1 text-[11px]"
      >
        <span
          data-testid="check-runs-summary"
          class="inline-flex items-center gap-2 whitespace-nowrap text-[10px] uppercase tracking-wider text-[var(--dim)]"
          title={
            summary()
              ? `total ${summary()!.total} · passed ${summary()!.passed} · failed ${summary()!.failed} · pending ${summary()!.pending}`
              : "loading"
          }
        >
          <Show when={resource.loading}>
            <Loader2 aria-hidden="true" size={11} class="animate-spin" />
            <span>checks…</span>
          </Show>
          <Show when={!resource.loading && summary()}>
            <span>
              CI {summary()!.passed}/{summary()!.total}
              <Show when={summary()!.failed > 0}>
                <span class="text-[var(--danger,#d34)]"> · {summary()!.failed} failed</span>
              </Show>
              <Show when={summary()!.pending > 0}>
                <span> · {summary()!.pending} running</span>
              </Show>
            </span>
          </Show>
        </span>

        <Show when={runs().length > 0}>
          <span aria-hidden="true" class="opacity-30">│</span>
          <For each={runs()}>
            {(run) => {
              const tone = chipTone(run);
              const Icon = tone.Icon;
              const interactive = Boolean(run.detailsUrl);
              const className =
                "inline-flex shrink-0 items-center gap-1 rounded border border-[var(--border-weak,var(--border))] px-1.5 py-0.5 font-mono hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))]";
              const content = (
                <>
                  <Icon
                    aria-hidden="true"
                    size={11}
                    style={{ color: tone.color }}
                    class={run.status !== "completed" ? "animate-spin" : undefined}
                  />
                  <span class="max-w-32 truncate" title={run.name}>
                    {run.name}
                  </span>
                  <Show when={run.appName && run.appName !== "GitHub Actions"}>
                    <span class="text-[9px] text-[var(--dim)]">{run.appName}</span>
                  </Show>
                </>
              );
              return (
                <Show
                  when={interactive}
                  fallback={
                    <span
                      data-testid={`check-run-${run.id}`}
                      data-status={run.status}
                      data-conclusion={run.conclusion ?? "running"}
                      class={className}
                      title={`${run.name} · ${tone.label}`}
                    >
                      {content}
                    </span>
                  }
                >
                  <a
                    data-testid={`check-run-${run.id}`}
                    data-status={run.status}
                    data-conclusion={run.conclusion ?? "running"}
                    href={run.detailsUrl!}
                    target="_blank"
                    rel="noreferrer"
                    class={className + " text-[var(--fg)]"}
                    title={`${run.name} · ${tone.label} — open logs`}
                  >
                    {content}
                  </a>
                </Show>
              );
            }}
          </For>
        </Show>
      </section>
    </Show>
  );
}
