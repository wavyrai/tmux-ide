"use client";

import { useParams, useRouter } from "next/navigation";
import { TerminalPanel } from "@/components/TerminalPanel";

const WIDGETS = [
  { type: "warroom", label: "War Room" },
  { type: "tasks", label: "Tasks" },
  { type: "explorer", label: "Explorer" },
  { type: "preview", label: "Preview" },
];

export default function TerminalsPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const name = decodeURIComponent(params.name);

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-7 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`/project/${encodeURIComponent(name)}`)}
            className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            {"< back"}
          </button>
          <span className="text-[var(--border)]">|</span>
          <span className="text-[var(--accent)]">{name}</span>
          <span className="text-[var(--border)]">|</span>
          <span className="text-[var(--fg)]">live terminals</span>
        </div>
      </div>

      {/* 2x2 terminal grid */}
      <div className="flex-1 min-h-0 grid grid-cols-2 grid-rows-2">
        {WIDGETS.map((w) => (
          <TerminalPanel
            key={w.type}
            widgetType={w.type}
            className="flex flex-col border border-[var(--border)] overflow-hidden"
          />
        ))}
      </div>
    </div>
  );
}
