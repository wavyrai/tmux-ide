import { docs } from "fumadocs-mdx:collections/server";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { AGENT_PROMPT } from "@/lib/agent-prompt";

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, "image.webp"];

  return {
    segments,
    url: `/og/docs/${segments.join("/")}`,
  };
}

const CALLOUT_LABELS: Record<string, string> = {
  warn: "Warning",
  warning: "Warning",
  error: "Warning",
  success: "Tip",
  info: "Note",
};

/**
 * Turn the MDX components a page uses into plain Markdown, so the .md twins
 * and llms-full.txt never show raw JSX to an agent.
 */
export function mdxToMarkdown(markdown: string): string {
  return (
    markdown
      // The copy-prompt button: give the prompt itself (AGENT_PROMPT is its only copy).
      .replace(/^[ \t]*<CopyAgentPrompt\s*\/>[ \t]*$/gmu, `\`\`\`text\n${AGENT_PROMPT}\n\`\`\``)
      // Callouts become labelled blockquotes.
      .replace(
        /^[ \t]*<Callout(?:\s+type="([a-z]+)")?[^>]*>\n?([\s\S]*?)\n?[ \t]*<\/Callout>/gmu,
        (_match, type: string | undefined, body: string) => {
          const lines = body
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const label = CALLOUT_LABELS[type ?? "info"] ?? "Note";
          return [`> **${label}:** ${lines[0] ?? ""}`, ...lines.slice(1).map((l) => `> ${l}`)].join(
            "\n",
          );
        },
      )
      // Heading anchors ("## Install [#install]") are fumadocs syntax, not Markdown.
      .replace(/^(#{1,6} .*?) \[#[\w-]+\]$/gmu, "$1")
      // Figures are visual; their captions repeat the surrounding prose.
      .replace(/^[ \t]*<[A-Z][A-Za-z]*(?:\s[^>]*)?\/>[ \t]*\n?/gmu, "")
  );
}

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed");
  const description = page.data.description ? `> ${page.data.description}\n\n` : "";

  return `# ${page.data.title}

${description}${mdxToMarkdown(processed).trimStart()}`;
}
