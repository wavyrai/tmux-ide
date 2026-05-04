"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { SessionSnapshot } from "@/lib/useSessionStream";
import { StatusPopover } from "./StatusPopover";

export function SkillsSegment({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const data = snapshot?.skills ?? [];

  if (!snapshot) return null;

  return (
    <>
      <span className="mx-2 opacity-30">│</span>
      <StatusPopover
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            data-testid="status-segment-skills"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1 text-left text-[var(--dim)] transition-colors motion-safe:active:scale-[0.98] hover:text-[var(--fg)]"
          >
            <Sparkles aria-hidden="true" size={12} />
            {data.length > 0 ? `${data.length} skills` : "none"}
          </button>
        }
      >
        <div className="space-y-2">
          <div className="text-[var(--accent)]">skills</div>
          {data.length === 0 ? (
            <div className="text-[var(--dim)]">no skills</div>
          ) : (
            <div className="flex max-w-sm flex-wrap gap-1">
              {data.map((skill) => (
                <span
                  key={skill.name}
                  className="border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--cyan)]"
                  title={skill.specialties.join(", ")}
                >
                  {skill.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </StatusPopover>
    </>
  );
}
