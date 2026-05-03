"use client";

import { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fetchCoverage, fetchValidation, type ValidationData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

interface ValidationViewProps {
  sessionName: string;
}

type StatusKey = "passing" | "failing" | "pending" | "blocked";

const STATUS_ORDER: StatusKey[] = ["failing", "blocked", "pending", "passing"];

const STATUS_META: Record<StatusKey, { label: string; color: string; bg: string }> = {
  failing: { label: "failing", color: "var(--red)", bg: "rgba(252, 83, 58, 0.1)" },
  blocked: { label: "blocked", color: "var(--yellow)", bg: "rgba(252, 213, 58, 0.1)" },
  pending: { label: "pending", color: "var(--dim)", bg: "var(--surface)" },
  passing: { label: "passing", color: "var(--green)", bg: "rgba(155, 205, 151, 0.1)" },
};

function isStatusKey(value: string): value is StatusKey {
  return value === "passing" || value === "failing" || value === "pending" || value === "blocked";
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function buckets(validation: ValidationData | null) {
  const initial: Record<StatusKey, number> = { passing: 0, failing: 0, pending: 0, blocked: 0 };
  if (!validation?.state) return { ...initial, total: 0 };
  let total = 0;
  for (const entry of Object.values(validation.state.assertions)) {
    total += 1;
    if (isStatusKey(entry.status)) initial[entry.status] += 1;
  }
  return { ...initial, total };
}

function StatusPill({ status }: { status: string }) {
  const meta = isStatusKey(status) ? STATUS_META[status] : null;
  const color = meta?.color ?? "var(--dim)";
  const bg = meta?.bg ?? "var(--surface)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em]"
      style={{ color, background: bg }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      {meta?.label ?? status}
    </span>
  );
}

function KpiCard({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number | string;
  color?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-[var(--accent)] bg-[var(--surface-active)]"
          : "border-[var(--border-weak)] bg-[var(--bg-strong)] hover:bg-[var(--surface-hover)]"
      } ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">{label}</span>
      <span className="text-lg tabular-nums" style={{ color: color ?? "var(--fg)" }}>
        {value}
      </span>
    </button>
  );
}

export function ValidationView({ sessionName }: ValidationViewProps) {
  const validationFetcher = useCallback(() => fetchValidation(sessionName), [sessionName]);
  const { data: validation } = usePolling(validationFetcher, 3000);
  const coverageFetcher = useCallback(() => fetchCoverage(sessionName), [sessionName]);
  const { data: coverage } = usePolling(coverageFetcher, 5000);

  const [filter, setFilter] = useState<StatusKey | "all">("all");

  const stats = useMemo(() => buckets(validation), [validation]);
  const passingPct = stats.total === 0 ? 0 : Math.round((stats.passing / stats.total) * 100);

  const assertionRows = useMemo(() => {
    if (!validation?.state) return [];
    const entries = Object.entries(validation.state.assertions).map(([id, value]) => ({
      id,
      ...value,
    }));
    const ordered = entries.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status as StatusKey);
      const bi = STATUS_ORDER.indexOf(b.status as StatusKey);
      const aWeight = ai === -1 ? 99 : ai;
      const bWeight = bi === -1 ? 99 : bi;
      if (aWeight !== bWeight) return aWeight - bWeight;
      return a.id.localeCompare(b.id);
    });
    return filter === "all" ? ordered : ordered.filter((row) => row.status === filter);
  }, [validation, filter]);

  if (!validation) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center bg-[var(--bg)] p-8 text-center text-[var(--dim)]">
        <div className="text-[13px]">No validation contract found</div>
        <div className="mt-1 max-w-sm text-[11px]">
          Add a <code className="rounded-sm bg-[var(--surface)] px-1">.tasks/validation-contract.md</code> file
          to this project to start tracking assertions.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <div className="flex-1 space-y-5 overflow-auto p-4">
        {/* KPI strip + progress bar */}
        <section className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <KpiCard
              label="total"
              value={stats.total}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <KpiCard
              label="passing"
              value={stats.passing}
              color={STATUS_META.passing.color}
              active={filter === "passing"}
              onClick={() => setFilter("passing")}
            />
            <KpiCard
              label="failing"
              value={stats.failing}
              color={STATUS_META.failing.color}
              active={filter === "failing"}
              onClick={() => setFilter("failing")}
            />
            <KpiCard
              label="pending"
              value={stats.pending}
              color={STATUS_META.pending.color}
              active={filter === "pending"}
              onClick={() => setFilter("pending")}
            />
            <KpiCard
              label="blocked"
              value={stats.blocked}
              color={STATUS_META.blocked.color}
              active={filter === "blocked"}
              onClick={() => setFilter("blocked")}
            />
          </div>

          <div
            className="flex items-center gap-3 rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] px-3 py-2"
            data-testid="validation-progress"
          >
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--dim)]">
              progress
            </span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border-weak)]">
              <div
                className="absolute inset-y-0 left-0 transition-[width] duration-200"
                style={{
                  width: `${passingPct}%`,
                  background:
                    stats.failing > 0
                      ? `linear-gradient(to right, ${STATUS_META.passing.color} 0%, ${STATUS_META.passing.color} 100%)`
                      : STATUS_META.passing.color,
                }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-[var(--fg-secondary)]">
              {stats.passing}/{stats.total} ({passingPct}%)
            </span>
            {validation.state?.lastVerified && (
              <>
                <span className="text-[var(--dimmer)]">·</span>
                <span className="text-[11px] text-[var(--dim)]">
                  verified {formatRelative(validation.state.lastVerified)}
                </span>
              </>
            )}
          </div>
        </section>

        {/* Assertions */}
        {assertionRows.length > 0 ? (
          <section>
            <header className="mb-2 flex items-center justify-between">
              <h3 className="text-[12px] uppercase tracking-[0.08em] text-[var(--accent)]">
                assertions
                {filter !== "all" && (
                  <span className="ml-2 text-[var(--dim)] normal-case tracking-normal">
                    · filtering {STATUS_META[filter].label}
                  </span>
                )}
              </h3>
              <span className="text-[11px] tabular-nums text-[var(--dim)]">
                {assertionRows.length} shown
              </span>
            </header>
            <div className="divide-y divide-[var(--border-weak)] overflow-hidden rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)]">
              {assertionRows.map((row) => (
                <div
                  key={row.id}
                  data-testid="validation-assertion"
                  data-status={row.status}
                  className="flex items-start gap-3 px-3 py-2 hover:bg-[var(--surface-hover)]"
                >
                  <code className="w-32 shrink-0 truncate text-[12px] text-[var(--fg)]">
                    {row.id}
                  </code>
                  <StatusPill status={row.status} />
                  <div className="min-w-0 flex-1">
                    {row.evidence && (
                      <div className="truncate text-[12px] text-[var(--fg-secondary)]">
                        {row.evidence}
                      </div>
                    )}
                    {row.verifiedBy && (
                      <div className="mt-0.5 text-[10px] text-[var(--dim)]">
                        verified by{" "}
                        <span className="text-[var(--cyan)]">@{row.verifiedBy}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          filter !== "all" && (
            <div className="rounded-md border border-dashed border-[var(--border-weak)] bg-[var(--bg-strong)] p-4 text-center text-[12px] text-[var(--dim)]">
              No assertions in <strong>{STATUS_META[filter].label}</strong>.
            </div>
          )
        )}

        {/* Coverage warnings */}
        {coverage && (coverage.unclaimed.length > 0 || Object.keys(coverage.duplicates).length > 0) && (
          <section className="space-y-2">
            <h3 className="text-[12px] uppercase tracking-[0.08em] text-[var(--accent)]">coverage</h3>
            {coverage.unclaimed.length > 0 && (
              <div
                className="rounded-md border-l-2 border-[var(--yellow)] bg-[var(--bg-strong)] px-3 py-2"
                data-testid="coverage-unclaimed"
              >
                <div className="mb-1 text-[11px] uppercase tracking-[0.05em] text-[var(--yellow)]">
                  {coverage.unclaimed.length} unclaimed assertion
                  {coverage.unclaimed.length === 1 ? "" : "s"}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {coverage.unclaimed.map((id) => (
                    <code
                      key={id}
                      className="rounded-sm bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--fg-secondary)]"
                    >
                      {id}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(coverage.duplicates).length > 0 && (
              <div
                className="rounded-md border-l-2 border-[var(--cyan)] bg-[var(--bg-strong)] px-3 py-2"
                data-testid="coverage-duplicates"
              >
                <div className="mb-1 text-[11px] uppercase tracking-[0.05em] text-[var(--cyan)]">
                  duplicate claims
                </div>
                <div className="space-y-0.5">
                  {Object.entries(coverage.duplicates).map(([id, taskIds]) => (
                    <div key={id} className="text-[11px] text-[var(--fg-secondary)]">
                      <code className="text-[var(--fg)]">{id}</code>
                      <span className="text-[var(--dim)]"> ← claimed by </span>
                      {taskIds.map((tid, i) => (
                        <span key={tid}>
                          <code className="text-[var(--cyan)]">{tid}</code>
                          {i < taskIds.length - 1 && <span className="text-[var(--dim)]">, </span>}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Contract markdown */}
        {validation.contract && (
          <section>
            <h3 className="mb-2 text-[12px] uppercase tracking-[0.08em] text-[var(--accent)]">
              contract
            </h3>
            <div className="plan-content rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] p-4">
              <ReactMarkdown>{validation.contract}</ReactMarkdown>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
