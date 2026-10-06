"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { CopyGlyph, useCopy } from "@/components/copy-status";
import { AGENT_PROMPT } from "@/lib/agent-prompt";

/** How long the beam stays powered after a copy lands. */
const BEAM_ON_MS = 900;
/** The ramp-off; matches the .prompt-beam opacity transition in global.css. */
const BEAM_FADE_MS = 450;

type BeamPhase = "on" | "fading" | null;

const GLYPH_SIZE = { hero: 15, default: 14 } as const;

/**
 * "Copy agent prompt": an inverted pill that copies AGENT_PROMPT, the single
 * source for the text shown beneath it and the text placed on the clipboard.
 *
 * The harness marks, the fixed label and a copy glyph sit in the pill; the
 * glyph swaps to a green check inside one grid cell, so the pill never
 * resizes. A landed copy powers a border beam around the pill for
 * BEAM_ON_MS and ramps it off; under reduced motion it never runs (the check
 * still shows). Failure leaves a visible message and the prompt selectable.
 */
export function CopyAgentPromptClient({
  size,
  marks,
  showPrompt,
  className,
}: {
  size: "default" | "hero";
  showPrompt: boolean;
  /** Server-rendered harness marks, passed through so their paths stay out of the bundle. */
  marks: ReactNode;
  className: string;
}) {
  const { status, copy } = useCopy();
  const promptId = useId();
  const [beam, setBeam] = useState<BeamPhase>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const powerBeam = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setBeam("on");
    timers.current.push(
      setTimeout(() => setBeam("fading"), BEAM_ON_MS),
      setTimeout(() => setBeam(null), BEAM_ON_MS + BEAM_FADE_MS),
    );
  };

  const onClick = async () => {
    if (await copy(AGENT_PROMPT)) powerBeam();
  };

  return (
    <div className={`agent-prompt not-prose ${className}`}>
      <span className="prompt-frame" data-beam={beam ?? undefined}>
        <button
          type="button"
          onClick={() => void onClick()}
          data-size={size}
          data-state={status}
          aria-describedby={promptId}
          title={showPrompt ? undefined : AGENT_PROMPT}
          className="prompt-pill"
        >
          {marks}
          Copy agent prompt
          <CopyGlyph status={status} size={GLYPH_SIZE[size]} />
        </button>
        <span aria-hidden className="prompt-beam" />
      </span>
      <p className={showPrompt ? "type-caption-1 mt-3 text-fd-muted-foreground" : "sr-only"}>
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
