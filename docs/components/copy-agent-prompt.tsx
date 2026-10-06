import { CopyAgentPromptClient } from "@/components/copy-agent-prompt-client";
import { HarnessMarks } from "@/components/harness-marks";

/**
 * The "Copy agent prompt" pill. This server wrapper renders the static
 * harness marks; the client part only carries the copy state and the beam.
 */
export function CopyAgentPrompt({
  size = "default",
  showPrompt = true,
  className = "",
}: {
  size?: "default" | "hero";
  /** Show the "Copies …" line; when false it stays for assistive tech and as a tooltip. */
  showPrompt?: boolean;
  className?: string;
}) {
  return (
    <CopyAgentPromptClient
      size={size}
      showPrompt={showPrompt}
      className={className}
      marks={<HarnessMarks size={size === "hero" ? 16 : 14} />}
    />
  );
}
