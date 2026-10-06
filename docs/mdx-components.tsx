import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { CopyAgentPrompt } from "@/components/copy-agent-prompt";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CopyAgentPrompt,
    ...components,
  };
}
