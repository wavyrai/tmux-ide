import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { CopyAgentPrompt } from "@/components/copy-agent-prompt";
import { AgentDetectionFigure, AgentTeamsTree } from "@/components/figures/figures";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CopyAgentPrompt,
    // Figures for docs pages: static fleet trees, numbered within the page.
    AgentTeamsFigure: AgentTeamsTree,
    AgentDetectionFigure,
    ...components,
  };
}
