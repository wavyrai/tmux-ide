import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const readRoot = (path) => readFileSync(resolve(root, path), "utf8");
const fail = (message) => {
  console.error(`product docs: ${message}`);
  process.exitCode = 1;
};

const packageVersion = JSON.parse(readRoot("package.json")).version;
const cliSource = readRoot("bin/cli.ts");
const commandsDoc = readRoot("docs/content/docs/commands.mdx");
const templatesDoc = readRoot("docs/content/docs/templates.mdx");
const releasePath = `release-${packageVersion.replaceAll(".", "-")}.mdx`;
const releaseDoc = readRoot(`docs/content/docs/${releasePath}`);
const configurationDoc = readRoot("docs/content/docs/configuration.mdx");

for (const [path, content] of [
  ["commands.mdx", commandsDoc],
  ["templates.mdx", templatesDoc],
  [releasePath, releaseDoc],
]) {
  if (!content.includes(packageVersion)) {
    fail(`${path} does not name the current package version ${packageVersion}`);
  }
}

const helpBlock = cliSource.slice(
  cliSource.indexOf("function printHelp()"),
  cliSource.indexOf("// The TUI surfaces"),
);
const publicCommands = new Set(
  [...helpBlock.matchAll(/cyan\(\"tmux-ide ([a-z][a-z-]*)/g)].map((match) => match[1]),
);
for (const command of [...publicCommands].sort()) {
  if (!commandsDoc.includes(`tmux-ide ${command}`)) {
    fail(`commands.mdx is missing the public \`${command}\` command from --help`);
  }
}

const widgetSource = readRoot("packages/daemon/src/widgets/resolve.ts");
const widgetMap =
  widgetSource.match(/const WIDGET_ENTRY_POINTS:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? "";
const widgetTypes = [...widgetMap.matchAll(/^\s{2}([a-z-]+):/gm)].map((match) => match[1]);
const paneSchema = readRoot("packages/contracts/src/ide-config.ts");
const paneTypeEnum = paneSchema.match(/type: z\s*\.enum\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
const schemaPaneTypes = new Set(
  [...paneTypeEnum.matchAll(/\"([a-z-]+)\"/g)].map((match) => match[1]),
);
for (const widget of widgetTypes.filter((widget) => schemaPaneTypes.has(widget))) {
  if (!configurationDoc.includes(`\`${widget}\``)) {
    fail(`configuration.mdx is missing implemented widget type \`${widget}\``);
  }
}

// Quarantined surfaces (runtime/product-surface-policy.ts) stay in the schema but
// must be documented as absent from the app, never as available views.
const surfacePolicy = readRoot("packages/daemon/src/tui/mirror/runtime/product-surface-policy.ts");
const listConst = (name) =>
  [
    ...(surfacePolicy.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(
      /"([a-z-]+)"/g,
    ),
  ].map((match) => match[1]);
const defaultPanels = listConst("DEFAULT_PRODUCT_CANVAS_PANELS");
const quarantinedSurfaces = listConst("QUARANTINED_PRODUCT_SURFACES");
if (defaultPanels.length === 0 || quarantinedSurfaces.length === 0) {
  fail("could not read the product surface policy");
}

const workspaceSchema = readRoot("packages/contracts/src/workspace-config.ts");
const panelEnum =
  workspaceSchema.match(/WorkspacePanelKindSchemaZ = z\.enum\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
const panelKinds = [...panelEnum.matchAll(/\"([a-z-]+)\"/g)].map((match) => match[1]);
for (const panel of panelKinds) {
  if (!configurationDoc.includes(`\`${panel}\``)) {
    fail(`configuration.mdx is missing workspace panel kind \`${panel}\``);
  }
}
if (panelKinds.some((panel) => !defaultPanels.includes(panel))) {
  if (!configurationDoc.includes("does not read `app.views`")) {
    fail("configuration.mdx must state that the app does not read `app.views`");
  }
}

// The app's root surfaces and shipped function keys must be the documented ones.
const docsDir = resolve(root, "docs/content/docs");
const pages = Object.fromEntries(
  readdirSync(docsDir)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => [file.replace(/\.mdx$/, ""), readFileSync(resolve(docsDir, file), "utf8")]),
);
const titleCase = (id) => id[0].toUpperCase() + id.slice(1);
for (const panel of defaultPanels) {
  for (const page of ["index", "app-surfaces"]) {
    if (!pages[page].includes(`**${titleCase(panel)}**`)) {
      fail(`${page}.mdx does not name the \`${panel}\` app surface`);
    }
  }
}
const chromeActions = readRoot(
  "packages/daemon/src/tui/mirror/workspace/application-action-descriptions.ts",
);
const chromeKeys = new Set(
  [
    ...(chromeActions.match(/CHROME_ACTIONS = \{([\s\S]*?)\} as const/)?.[1] ?? "").matchAll(
      /keys: "(F\d+)"/g,
    ),
  ].map((match) => match[1]),
);
for (const key of chromeKeys) {
  if (!pages["getting-started"].includes(`\`${key}\``)) {
    fail(`getting-started.mdx is missing the shipped app key \`${key}\``);
  }
}
// F8 (history) and F9 (tabs) are shipped through the fleet shortcut handler.
for (const key of ["F3", "F4", "F11", "F12"]) {
  if (new RegExp(`\`${key}\``).test(pages["getting-started"])) {
    fail(`getting-started.mdx documents \`${key}\`, which the 2.9 app does not bind`);
  }
}
for (const surface of quarantinedSurfaces) {
  const label = titleCase(surface);
  for (const page of ["index", "getting-started"]) {
    for (const line of pages[page].split("\n")) {
      if (line.includes(`**${label}**`)) {
        fail(`${page}.mdx presents the quarantined ${label} surface as a feature`);
      }
    }
  }
}

// Every internal docs link must reach an existing page and heading.
const slug = (heading) =>
  heading
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
const anchors = Object.fromEntries(
  Object.entries(pages).map(([page, content]) => [
    page,
    new Set(
      content
        .replace(/```[\s\S]*?```/g, "")
        .split("\n")
        .filter((line) => /^#{2,6} /.test(line))
        .map((line) => slug(line.replace(/^#+ /, ""))),
    ),
  ]),
);
for (const [page, content] of Object.entries(pages)) {
  if (content.includes("```mermaid"))
    fail(`${page}.mdx uses a mermaid block, which is not rendered`);
  for (const [, anchor] of content.matchAll(/\]\(#([a-z0-9-]+)\)/g)) {
    if (!anchors[page].has(anchor)) fail(`${page}.mdx links to missing anchor #${anchor}`);
  }
  for (const [, target, anchor] of content.matchAll(
    /\]\(\/docs(?:\/([a-z0-9-]+))?(?:#([a-z0-9-]+))?\)/g,
  )) {
    const targetPage = target ?? "index";
    if (!pages[targetPage]) {
      fail(`${page}.mdx links to missing page /docs/${targetPage}`);
    } else if (anchor && !anchors[targetPage].has(anchor)) {
      fail(`${page}.mdx links to missing anchor /docs/${target ?? ""}#${anchor}`);
    }
  }
}

// Banned filler from docs/contributing/writing-guide.md, checked in prose only.
const bannedFiller =
  /\b(simply|seamless(?:ly)?|effortless(?:ly)?|powerful|blazing|leverag(?:e|es|ing)|utiliz(?:e|es|ing)|in order to|delve|supercharge|game-changer|the whole point|aspirational)\b/giu;
for (const [page, content] of Object.entries(pages)) {
  const prose = content
    .replace(/^---[\s\S]*?---/u, "")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`/gu, "");
  for (const match of prose.matchAll(bannedFiller)) {
    fail(`${page}.mdx uses banned filler "${match[0]}" (see docs/contributing/writing-guide.md)`);
  }
}

if (!process.exitCode) console.log("product docs: source-aligned");
