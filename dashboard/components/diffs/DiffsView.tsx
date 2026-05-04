"use client";

import { DiffPanel } from "./DiffPanel";
import { Panel } from "@/components/ui";

interface DiffsViewProps {
  sessionName: string;
}

export function DiffsView({ sessionName }: DiffsViewProps) {
  return (
    <Panel>
      <DiffPanel sessionName={sessionName} />
    </Panel>
  );
}
