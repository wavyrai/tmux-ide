"use client";

import { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fetchCoverage, fetchValidation, type ValidationData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import {
  EmptyState,
  KpiCard,
  Panel,
  PanelBody,
  SectionHeader,
  SkeletonCard,
  SkeletonText,
  StatusPill,
} from "@/components/ui";

interface ValidationViewProps {
  sessionName: string;
}

type StatusKey = "passing" | "failing" | "pending" | "blocked";

const STATUS_ORDER: StatusKey[] = ["failing", "blocked", "pending", "passing"];

const STATUS_META: Record<StatusKey, { label: string; color: string }> = {
  failing: { label: "failing", color: "var(--red)" },
  blocked: { label: "blocked", color: "var(--yellow)" },
  pending: { label: "pending", color: "var(--dim)" },
  passing: { label: "passing", color: "var(--green)" },
};

function isStatusKey(value: string): value is StatusKey {
  return value === "passing" || value === "failing" || value === "pending" || value === "blocked";
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
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

export function ValidationView({ sessionName }: ValidationViewProps) {
  const validationFetcher = useCallback(() => fetchValidation(sessionName), [sessionName]);
  const { data: validation, loading } = usePolling(validationFetcher, 10000);
  const coverageFetcher = useCallback(() => fetchCoverage(sessionName), [sessionName]);
  const { data: coverage } = usePolling(coverageFetcher, 10000);
  const [filter, setFilter] = useState<StatusKey | "all">("all");

  const stats = useMemo(() => buckets(validation), [validation]);
  const passingPct = stats.total === 0 ? 0 : Math.round((stats.passing / stats.total) * 100);
  const coverageGaps = useMemo(() => {
    const rows: Array<{ type: string; message: string; file?: string }> = [];
    for (const item of coverage?.unclaimed ?? []) {
      rows.push({ type: "unclaimed", message: item });
    }
    for (const [key, files] of Object.entries(coverage?.duplicates ?? {})) {
      rows.push({
        type: "duplicate",
        message: key,
        file: files.join(", "),
      });
    }
    return rows;
  }, [coverage]);

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

  if (!validation && loading) {
    return (
      <Panel>
        <PanelBody className="space-y-5 p-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
          <SkeletonText lines={6} />
        </PanelBody>
      </Panel>
    );
  }

  if (!validation) {
    return (
      <Panel>
        <EmptyState
          title="No validation contract found"
          body={
            <>
              Add a{" "}
              <code className="rounded-md bg-[var(--surface)] px-1">
                .tasks/validation-contract.md
              </code>{" "}
              file to this project to start tracking assertions.
            </>
          }
          className="flex-1"
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelBody className="space-y-5 p-4">
        <section className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
            <KpiCard
              label="total"
              value={stats.total}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            {[...STATUS_ORDER].reverse().map((status) => (
              <KpiCard
                key={status}
                label={STATUS_META[status].label}
                value={stats[status]}
                color={STATUS_META[status].color}
                active={filter === status}
                onClick={() => setFilter(status)}
              />
            ))}
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
                style={{ width: `${passingPct}%`, background: STATUS_META.passing.color }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-[var(--fg-secondary)]">
              {stats.passing}/{stats.total} ({passingPct}%)
            </span>
            {validation.state?.lastVerified && (
              <>
                <span className="text-[var(--dimmer)]">·</span>
                <span className="text-[11px] tabular-nums text-[var(--dim)]">
                  verified {formatRelative(validation.state.lastVerified)}
                </span>
              </>
            )}
          </div>
        </section>

        {assertionRows.length > 0 ? (
          <section>
            <SectionHeader
              label={
                <>
                  assertions
                  {filter !== "all" && (
                    <span className="ml-2 text-[var(--dim)] normal-case tracking-normal">
                      - filtering {STATUS_META[filter].label}
                    </span>
                  )}
                </>
              }
              rightSlot={
                <span className="text-[11px] tabular-nums text-[var(--dim)]">
                  {assertionRows.length} shown
                </span>
              }
            />
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
                  <StatusPill
                    variant={isStatusKey(row.status) ? row.status : "pending"}
                    label={isStatusKey(row.status) ? STATUS_META[row.status].label : row.status}
                  />
                  <div className="min-w-0 flex-1">
                    {row.evidence && (
                      <div className="truncate text-[12px] text-[var(--fg-secondary)]">
                        {row.evidence}
                      </div>
                    )}
                    {row.verifiedBy && (
                      <div className="mt-0.5 text-[10px] text-[var(--dim)]">
                        verified by <span className="text-[var(--cyan)]">@{row.verifiedBy}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          filter !== "all" && (
            <EmptyState
              title={
                <>
                  No assertions in <strong>{STATUS_META[filter].label}</strong>.
                </>
              }
              className="rounded-md border border-dashed border-[var(--border-weak)] bg-[var(--bg-strong)]"
            />
          )
        )}

        {validation.contract && (
          <section>
            <SectionHeader label="contract" />
            <div className="plan-content rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] p-4">
              <ReactMarkdown>{validation.contract}</ReactMarkdown>
            </div>
          </section>
        )}

        {coverageGaps.length > 0 && (
          <section>
            <SectionHeader
              label="coverage gaps"
              rightSlot={
                <span className="text-[11px] tabular-nums text-[var(--yellow)]">
                  {coverageGaps.length}
                </span>
              }
            />
            <div className="space-y-2">
              {coverageGaps.map((gap, index) => (
                <div
                  key={`${gap.type}-${index}`}
                  className="rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] px-3 py-2 text-[12px]"
                >
                  <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--yellow)]">
                    {gap.type.replaceAll("_", " ")}
                  </div>
                  <div className="text-[var(--fg-secondary)]">{gap.message}</div>
                  {gap.file && (
                    <code className="mt-1 inline-flex rounded-md bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--fg-secondary)]">
                      {gap.file}
                    </code>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </PanelBody>
    </Panel>
  );
}
