import type { Node } from "fumadocs-core/page-tree";
import { source } from "@/lib/source";
import {
  APP_COMMAND,
  CURRENT_RELEASE_PATH,
  INSTALL_COMMAND,
  PUBLISHER_NAME,
  PUBLISHER_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_REPOSITORY,
  SOFTWARE_DOWNLOAD_URL,
  SOFTWARE_VERSION,
  absoluteUrl,
} from "@/lib/site";

function link(title: string, url: string, description?: string): string {
  const notes = description?.trim();
  return `- [${title}](${absoluteUrl(url)})${notes ? `: ${notes}` : ""}`;
}

function pageLines(nodes: Node[]): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type === "page") {
      const page = source.getNodePage(node);
      if (!page) continue;
      lines.push(link(page.data.title, page.url, page.data.description));
    } else if (node.type === "folder") {
      if (node.index) lines.push(...pageLines([node.index]));
      lines.push(...pageLines(node.children));
    }
  }
  return lines;
}

/** Older release notes are useful history but not needed to use tmux-ide. */
function isOptional(node: Node): boolean {
  return (
    node.type === "page" &&
    node.url.startsWith("/docs/release-") &&
    node.url !== CURRENT_RELEASE_PATH
  );
}

/** The /llms.txt index (llmstxt.org): H1, summary, then link sections in sidebar order. */
export function llmsIndex(): string {
  const groups: { title: string; nodes: Node[] }[] = [{ title: "Docs", nodes: [] }];
  const optional: Node[] = [];
  for (const node of source.pageTree.children) {
    if (node.type === "separator") {
      groups.push({ title: typeof node.name === "string" ? node.name : "More", nodes: [] });
    } else if (isOptional(node)) {
      optional.push(node);
    } else {
      groups.at(-1)!.nodes.push(node);
    }
  }

  // Sections are keyed by title so the project links join a "Project" nav group
  // instead of repeating the heading.
  const sections = new Map<string, string[]>();
  const add = (title: string, lines: string[]) => {
    if (lines.length) sections.set(title, [...(sections.get(title) ?? []), ...lines]);
  };
  for (const group of groups) add(group.title, pageLines(group.nodes));
  add("Project", [
    link(
      "Manual for AI agents",
      "/agents.md",
      "install, the agent status contract, and the commands agents use to coordinate",
    ),
    `- [Source code on GitHub](${SITE_REPOSITORY}): issues, releases, and the MIT license`,
    `- [npm package](${SOFTWARE_DOWNLOAD_URL}): the published \`tmux-ide\` CLI`,
    `- [${PUBLISHER_NAME}](${PUBLISHER_URL}): the team that builds tmux-ide`,
  ]);
  add("Optional", [
    link("Full documentation as one file", "/llms-full.txt", "every docs page in Markdown"),
    ...pageLines(optional),
  ]);
  // llmstxt.org: "Optional" is the last section; agents may skip it.
  const optionalLines = sections.get("Optional")!;
  sections.delete("Optional");
  sections.set("Optional", optionalLines);

  const out = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `${SITE_NAME} is an open-source ${PUBLISHER_NAME} project (MIT license), current version ${SOFTWARE_VERSION}. ` +
      "tmux keeps owning processes, panes, and sessions; tmux-ide adds an agent-aware workspace on top, " +
      "so sessions keep running if tmux-ide closes.",
    "",
    `Install: \`${INSTALL_COMMAND}\` — then run \`${APP_COMMAND}\`.`,
    "",
    `AI agents: read ${absoluteUrl("/agents.md")} first — install, status reporting, and coordination commands in one page.`,
    "",
    "Every documentation page is also available as Markdown: append `.mdx` to its URL " +
      `(for example ${absoluteUrl("/docs/getting-started.mdx")}).`,
  ];
  for (const [title, lines] of sections) out.push("", `## ${title}`, "", ...lines);
  out.push("");
  return out.join("\n");
}
