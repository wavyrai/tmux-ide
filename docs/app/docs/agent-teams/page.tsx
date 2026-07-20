import { permanentRedirect } from "next/navigation";

/**
 * Stable compatibility entry point for links published before the guide moved
 * to its more descriptive `/docs/multi-agent-teams` slug.
 */
export default function AgentTeamsCompatibilityPage() {
  permanentRedirect("/docs/multi-agent-teams");
}
