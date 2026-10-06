"use client";

import { useId, useRef } from "react";

import { CopyGlyph, useCopy } from "@/components/copy-status";
import { HarnessMarks } from "@/components/harness-marks";
import { AGENT_PROMPT } from "@/lib/agent-prompt";

/**
 * "Copy agent prompt": an inverted pill that copies AGENT_PROMPT, the single
 * source for the text shown beneath it and the text placed on the clipboard.
 *
 * The label never changes, and the copy and check glyphs share one grid
 * cell, so the pill keeps its size. Success swaps in a green check, is
 * announced politely, and runs a one-shot ring around the pill: JS only sets
 * data-beam, CSS draws it, and neither runs under prefers-reduced-motion.
 * Failure leaves a visible message and the prompt stays selectable.
 */
export function CopyAgentPrompt({
  size = "default",
  className = "",
}: {
  size?: "default" | "hero";
  className?: string;
}) {
  const { status, copy } = useCopy();
  const promptId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const beamTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onClick = async () => {
    const ok = await copy(AGENT_PROMPT);
    const pill = button.current;
    if (!ok || !pill || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Restart the ring if it is already running.
    delete pill.dataset.beam;
    void pill.offsetWidth;
    pill.dataset.beam = "on";
    clearTimeout(beamTimer.current);
    beamTimer.current = setTimeout(() => delete pill.dataset.beam, 1600);
  };

  return (
    <div className={`agent-prompt not-prose ${className}`}>
      <button
        ref={button}
        type="button"
        onClick={() => void onClick()}
        data-size={size}
        aria-describedby={promptId}
        className="prompt-pill"
      >
        <HarnessMarks />
        <span>Copy agent prompt</span>
        <CopyGlyph status={status} />
      </button>
      <p className="type-caption-1 mt-3 text-fd-muted-foreground">
        Copies{" "}
        <span id={promptId} className="select-all text-fd-foreground">
          {AGENT_PROMPT}
        </span>
      </p>
      <p
        role="status"
        aria-live="polite"
        className={status === "failed" ? "type-caption-1 mt-2 text-fd-muted-foreground" : "sr-only"}
      >
        {status === "copied"
          ? "Agent prompt copied to clipboard."
          : status === "failed"
            ? "Could not copy automatically. Select the prompt above and copy it."
            : ""}
      </p>
    </div>
  );
}
