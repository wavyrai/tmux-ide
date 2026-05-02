"use client";

import { PlansPanel } from "@/components/PlansPanel";

interface PlansViewProps {
  sessionName: string;
}

export function PlansView({ sessionName }: PlansViewProps) {
  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <PlansPanel sessionName={sessionName} />
    </div>
  );
}
