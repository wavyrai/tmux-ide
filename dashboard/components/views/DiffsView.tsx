"use client";

import { DiffPanel } from "@/components/DiffPanel";

interface DiffsViewProps {
  sessionName: string;
}

export function DiffsView({ sessionName }: DiffsViewProps) {
  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <DiffPanel sessionName={sessionName} />
    </div>
  );
}
