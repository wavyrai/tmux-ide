"use client";

import { useCallback } from "react";
import { fetchCoverage, fetchValidation } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

interface ValidationViewProps {
  sessionName: string;
}

const STATUS_COLORS: Record<string, string> = {
  passing: "var(--green)",
  failing: "var(--red)",
  pending: "var(--dim)",
  blocked: "var(--yellow)",
};

export function ValidationView({ sessionName }: ValidationViewProps) {
  const validationFetcher = useCallback(() => fetchValidation(sessionName), [sessionName]);
  const { data: validation } = usePolling(validationFetcher, 3000);
  const coverageFetcher = useCallback(() => fetchCoverage(sessionName), [sessionName]);
  const { data: coverage } = usePolling(coverageFetcher, 5000);

  if (!validation) {
    return (
      <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] p-4 text-[var(--dim)] overflow-hidden">
        no validation contract found
      </div>
    );
  }

  const assertions = validation.state ? Object.entries(validation.state.assertions) : [];

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <div className="flex-1 space-y-4 overflow-auto p-4">
        {validation.contract && (
          <div>
            <h3 className="mb-1 text-[var(--accent)]">contract</h3>
            <pre className="whitespace-pre-wrap border border-[var(--border)] bg-[var(--surface)] p-2 text-[12px] text-[var(--fg)]">
              {validation.contract}
            </pre>
          </div>
        )}

        {assertions.length > 0 && (
          <div>
            <h3 className="mb-1 text-[var(--accent)]">assertions</h3>
            <div className="space-y-px">
              {assertions.map(([id, entry]) => (
                <div
                  key={id}
                  className="flex items-center gap-2 bg-[var(--surface)] px-2 py-0.5"
                >
                  <span className="w-32 shrink-0 text-[var(--fg)]">{id}</span>
                  <span
                    style={{ color: STATUS_COLORS[entry.status] ?? "var(--dim)" }}
                    className="w-16 shrink-0"
                  >
                    {entry.status}
                  </span>
                  {entry.verifiedBy && (
                    <span className="text-[11px] text-[var(--cyan)]">@{entry.verifiedBy}</span>
                  )}
                  {entry.evidence && (
                    <span className="truncate text-[11px] text-[var(--dim)]">
                      {entry.evidence}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {coverage &&
          (coverage.unclaimed.length > 0 || Object.keys(coverage.duplicates).length > 0) && (
            <div>
              <h3 className="mb-1 text-[var(--accent)]">coverage</h3>
              {coverage.unclaimed.length > 0 && (
                <div className="text-[12px] text-[var(--yellow)]">
                  unclaimed: {coverage.unclaimed.join(", ")}
                </div>
              )}
              {Object.entries(coverage.duplicates).map(([id, taskIds]) => (
                <div key={id} className="text-[12px] text-[var(--dim)]">
                  {id}: claimed by tasks {taskIds.join(", ")}
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
