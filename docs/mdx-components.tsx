import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { CopyAgentPrompt } from "@/components/copy-agent-prompt";
import { AgentDetectionFigure, AgentTeamsFigure } from "@/components/figures/figures";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CopyAgentPrompt,
    // Figures for docs pages: numbered within the page, titled at h3.
    AgentTeamsFigure: () => (
      <AgentTeamsFigure
        id="docs-agent-teams-figure"
        label="Fig. 1 / Delegation and synthesis"
        number="Figure 1."
        heading="h3"
      />
    ),
    AgentDetectionFigure,
    ...components,
  };
}
