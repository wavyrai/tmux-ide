import { homeLastModified } from "@/lib/git-dates";
import {
  INSTALL_METHODS,
  LANDING_AGENT_FEATURES,
  LANDING_CAPABILITIES,
  LANDING_FAQ,
  LANDING_HERO,
} from "@/lib/landing-content";
import {
  APP_COMMAND,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_REPOSITORY,
  SITE_TITLE,
  absoluteUrl,
  canonicalUrl,
} from "@/lib/site";

/** Markdown answers can stand in for an HTML page, so caches must key them on what was asked. */
export const MARKDOWN_VARY = "Accept, User-Agent";

export interface MarkdownMeta {
  readonly title: string;
  readonly description: string;
  /** Site path of the HTML page this markdown stands for. */
  readonly path: string;
  readonly lastUpdated: Date | undefined;
}

/** The `---` block agents read as document metadata; a date git can't back is left out. */
export function frontmatter({ title, description, path, lastUpdated }: MarkdownMeta): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `canonical: ${canonicalUrl(path)}`,
    ...(lastUpdated ? [`last_updated: ${lastUpdated.toISOString()}`] : []),
    "---",
    "",
  ];
  return lines.join("\n");
}

/** Site-relative markdown links (`](/docs/x)`) made absolute for agents reading out of context. */
function absoluteLinks(text: string): string {
  return text.replace(/\]\((\/[^)\s]*)\)/gu, (_match, path: string) => `](${absoluteUrl(path)})`);
}

/** The homepage as markdown, from the same copy the HTML page renders. */
export function homeMarkdown(): string {
  const out = [
    frontmatter({
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      path: "/",
      lastUpdated: homeLastModified(),
    }),
    `# ${SITE_NAME}`,
    "",
    `> ${LANDING_HERO.title}`,
    "",
    `${LANDING_HERO.ledeLead} ${LANDING_HERO.lede}`,
    "",
    "## Install",
    "",
  ];
  for (const method of INSTALL_METHODS) {
    out.push(`${method.label} (${method.note}):`, "", "```bash", method.command, "```", "");
  }
  out.push(`Then run \`${APP_COMMAND}\`.`, "", "## Agents", "");
  for (const feature of LANDING_AGENT_FEATURES) {
    out.push(`### ${feature.title}`, "", feature.body, "");
    if ("link" in feature)
      out.push(`[${feature.link.label}](${absoluteUrl(feature.link.href)})`, "");
  }
  out.push("## Ordinary tmux", "");
  for (const capability of LANDING_CAPABILITIES) {
    out.push(`### ${capability.title}`, "", capability.body, "");
  }
  out.push("## FAQ", "");
  for (const { question, answer } of LANDING_FAQ) {
    out.push(`### ${question}`, "", absoluteLinks(answer), "");
  }
  out.push(
    "## For agents",
    "",
    `- [Manual for AI agents](${absoluteUrl("/agents.md")}): install, the agent status contract, and the commands agents use to coordinate`,
    `- [llms.txt](${absoluteUrl("/llms.txt")}): index of the site`,
    `- [Docs index](${absoluteUrl("/docs/llms.txt")}): every docs page, in sidebar order`,
    `- [Full documentation](${absoluteUrl("/llms-full.txt")}): every docs page in one markdown file`,
    `- [Source code on GitHub](${SITE_REPOSITORY})`,
    "",
  );
  return out.join("\n");
}

/**
 * Body of a 404 asked for as markdown. It never repeats the requested path, so
 * a crafted URL can't put its own text in the answer.
 */
export function notFoundMarkdown(): string {
  return [
    "# Page not found",
    "",
    `${SITE_NAME} has no page at this address. Start from the documentation or the index for agents:`,
    "",
    `- [Documentation](${absoluteUrl("/docs")})`,
    `- [Docs index for agents](${absoluteUrl("/llms.txt")})`,
    `- [Manual for AI agents](${absoluteUrl("/agents.md")})`,
    "",
  ].join("\n");
}
