import { KNOWN_AGENTS } from "./agent-discovery.ts";

/**
 * Resolve a configured launch command to the stable agent id stamped on the
 * pane. Only executable-like argv tokens are considered so paths such as
 * `~/.claude/notes.md` cannot accidentally turn a regular editor into an
 * agent. Runtime process-tree detection remains the fallback for wrappers.
 */
export function agentHintForCommand(command: string | null | undefined): string | null {
  if (!command) return null;
  const parts = command.trim().split(/\s+/u).filter(Boolean);
  const candidates = parts
    .slice(0, 2)
    .filter((part) => !part.startsWith("-"))
    .map((part) => {
      const segments = part.split("/");
      return segments[segments.length - 1]?.toLowerCase() ?? "";
    });
  for (const agent of KNOWN_AGENTS) {
    if (candidates.includes(agent.bin.toLowerCase())) return agent.id;
  }
  return null;
}
