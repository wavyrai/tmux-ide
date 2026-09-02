import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = [resolve(root, "app"), resolve(root, "components")];
const sourceFiles = [];

function collect(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collect(path);
    else if ([".css", ".ts", ".tsx"].includes(extname(path))) sourceFiles.push(path);
  }
}

for (const directory of roots) collect(directory);

const sources = sourceFiles.map((path) => ({ path, source: readFileSync(path, "utf8") }));
const combined = sources.map(({ source }) => source).join("\n");
const failures = [];

if (/\btransition-all\b/u.test(combined)) failures.push("transition-all is forbidden");
if (/(?<!motion-safe:)active:scale-/u.test(combined)) {
  failures.push("press scale must be guarded by motion-safe");
}
const componentSource = sources
  .filter(({ path }) => extname(path) !== ".css")
  .map(({ source }) => source)
  .join("\n");
const hoverTokens = componentSource.match(/[^\s"'`]*hover:[^\s"'`]*/gu) ?? [];
if (hoverTokens.some((token) => !token.includes("hover-only:"))) {
  failures.push("hover feedback must be guarded by hover-only");
}
if (/\b(?:animate-fade-in|animate-pane-in)\b|@keyframes\s+(?:fadeIn|paneIn)\b/u.test(combined)) {
  failures.push("unused legacy entrance animations must stay removed");
}

const css = readFileSync(resolve(root, "app/global.css"), "utf8");
for (const token of [
  "--ease-smooth",
  "--ease-out-fluid",
  "--ease-in-quart",
  "@custom-variant hover-only",
]) {
  if (!css.includes(token)) failures.push(`missing shared motion primitive: ${token}`);
}

for (const { path, source } of sources.filter(({ path }) => extname(path) !== ".css")) {
  if (source.includes("transition-") && !source.includes("motion-reduce:transition-none")) {
    failures.push(
      `${path.replace(`${root}/`, "")} uses transitions without a reduced-motion override`,
    );
  }
  if (source.includes("animate-") && !source.includes("motion-reduce:animate-none")) {
    failures.push(
      `${path.replace(`${root}/`, "")} uses animation without a reduced-motion override`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Motion check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  "Motion verified: tokenized easing, explicit transitions, pointer-safe hover, guarded press feedback, and reduced-motion fallbacks.",
);
