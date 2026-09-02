import { readFileSync } from "node:fs";
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
const releaseDoc = readRoot("docs/content/docs/release-2-9-0-beta-1.mdx");
const configurationDoc = readRoot("docs/content/docs/configuration.mdx");

for (const [path, content] of [
  ["commands.mdx", commandsDoc],
  ["templates.mdx", templatesDoc],
  ["release-2-9-0-beta-1.mdx", releaseDoc],
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

const workspaceSchema = readRoot("packages/contracts/src/workspace-config.ts");
const panelEnum =
  workspaceSchema.match(/WorkspacePanelKindSchemaZ = z\.enum\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
const panelKinds = [...panelEnum.matchAll(/\"([a-z-]+)\"/g)].map((match) => match[1]);
for (const panel of panelKinds) {
  if (!configurationDoc.includes(`\`${panel}\``)) {
    fail(`configuration.mdx is missing workspace panel kind \`${panel}\``);
  }
}

if (!process.exitCode) console.log("product docs: source-aligned");
