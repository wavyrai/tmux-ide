"use client";

import { useId } from "react";

import { CopyGlyph, useCopy } from "@/components/copy-status";
import { AGENT_PROMPT } from "@/lib/agent-prompt";

/**
 * Shows the agent setup prompt and copies it in one click. The prompt stays
 * visible and selectable, so a failed clipboard write still leaves a manual
 * path; the result is announced through a polite live region.
 */
export function CopyAgentPrompt({ className = "" }: { className?: string }) {
  const { status, copy } = useCopy();
  const labelId = useId();

  return (
    <div className={`agent-prompt not-prose ${className}`}>
      <p id={labelId} className="type-caption-1 text-fd-muted-foreground">
        Or let your coding agent set it up
      </p>
      <div className="agent-prompt-box mt-2">
        <p className="type-body-2 min-w-0 flex-1 select-all text-fd-foreground">{AGENT_PROMPT}</p>
        <button
          type="button"
          onClick={() => void copy(AGENT_PROMPT)}
          aria-describedby={labelId}
          className="agent-prompt-button"
        >
          <CopyGlyph status={status} />
          Copy prompt
        </button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={status === "failed" ? "type-caption-1 mt-2 text-fd-muted-foreground" : "sr-only"}
      >
        {status === "copied"
          ? "Prompt copied to clipboard."
          : status === "failed"
            ? "Could not copy automatically. Select the prompt above and copy it."
            : ""}
      </p>
    </div>
  );
}
