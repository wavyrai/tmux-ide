import type { AgentProvider } from "../types";

export function providerDisplayName(provider: AgentProvider | null | undefined): string {
  if (!provider) return "Agent";
  switch (provider.kind) {
    case "claude-code":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "custom":
      return "Agent";
    default:
      return "Agent";
  }
}
