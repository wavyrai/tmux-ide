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
      lines.push(link(page.data.metaTitle ?? page.data.title, page.url, page.data.description));
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

/** Jobs tmux-ide is right for, and where it is not, from the docs and `tmux-ide --help`. */
const WHEN_TO_USE = [
  "- Several coding agents run in tmux and you need to know which one is working, blocked or done, " +
    "and which one needs the user: `tmux-ide team --json`.",
  "- You run inside a tmux pane and want to report your own state: " +
    '`tmux set-option -p @agent_state "working:$(date +%s)"`.',
  "- You need to wait for another agent or type into its pane: `tmux-ide wait agent-status`, " +
    "`tmux-ide wait output`, `tmux-ide send`.",
  "- The tmux server crashed and the sessions need rebuilding: `tmux-ide restore --resume-agents`.",
  "- You want a git worktree on a new branch with its own session: `tmux-ide worktree create <branch>`.",
  "",
  "It does not run on native Windows (use WSL), Alpine or other musl Linux, or Intel Macs. A tmux " +
    "server you started yourself must be tmux 3.7 or newer. Task or mission orchestration is not " +
    "part of this release.",
];

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
  add("Markdown", [
    link("Docs index", "/docs/llms.txt", "every docs page in sidebar order"),
    link("Homepage as Markdown", "/index.md", "what tmux-ide is, install, and the FAQ"),
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
    "Claude Code agent teams: set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `teammateMode` " +
      '`"tmux"` (or `"auto"` inside tmux) in `~/.claude/settings.json` (2.9.4 and later set this ' +
      "up in the installer); split-pane teammates then appear in tmux-ide grouped under " +
      "their team, named as the lead named them, with normal agent status. tmux-ide reads " +
      "`~/.claude/teams/<team>/config.json` read-only; Claude Code owns spawning, tasks and messaging. " +
      `Docs: ${absoluteUrl("/docs/claude-code-agent-teams")}`,
    "",
    "Every documentation page is also available as Markdown: append `.md` (or `.mdx`) to its URL " +
      `(for example ${absoluteUrl("/docs/getting-started.md")}), or request the page with ` +
      "`Accept: text/markdown`. Each Markdown page opens with `---` frontmatter: title, description, " +
      `canonical URL and last update. The homepage is ${absoluteUrl("/index.md")}.`,
    "",
    "## When to use tmux-ide",
    "",
    ...WHEN_TO_USE,
  ];
  for (const [title, lines] of sections) out.push("", `## ${title}`, "", ...lines);
  out.push("");
  return out.join("\n");
}

/** Sidebar groups of the docs: the separators' titles, each with the pages under it. */
function docsSections(): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let title = "Docs";
  const optional: Node[] = [];
  for (const node of source.pageTree.children) {
    if (node.type === "separator") {
      title = typeof node.name === "string" ? node.name : "More";
    } else if (isOptional(node)) {
      optional.push(node);
    } else {
      sections.set(title, [...(sections.get(title) ?? []), ...pageLines([node])]);
    }
  }
  sections.set("Optional", pageLines(optional));
  return sections;
}

/** The /docs/llms.txt index (llmstxt.org): the documentation section only, in sidebar order. */
export function docsLlmsIndex(): string {
  const out = [
    `# ${SITE_NAME} documentation`,
    "",
    `> The ${SITE_NAME} docs: install, the app, agent status detection, configuration, ` +
      "automation and multi-agent coordination, restore, worktrees, and release notes.",
    "",
    "Every page is also available as Markdown: append `.md` to its URL " +
      `(for example ${absoluteUrl("/docs/getting-started.md")}). ` +
      `The site-wide index is ${absoluteUrl("/llms.txt")}; the manual for AI agents is ${absoluteUrl("/agents.md")}.`,
  ];
  for (const [title, lines] of docsSections()) {
    if (lines.length) out.push("", `## ${title}`, "", ...lines);
  }
  out.push("");
  return out.join("\n");
}
