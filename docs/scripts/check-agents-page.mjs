import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The "tmux for coding agents" landing page (#643), checked in the build: it
// targets the searches "tmux for agents", "tmux codex" and "tmux agent status",
// so its title, H1, canonical and sitemap entry must carry the phrase, and the
// homepage, the docs pages on those topics, llms.txt and agents.md must link
// to it. The /dev design mockup it grew from must be gone.

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const PATH = "/tmux-for-coding-agents";
const PHRASE = "tmux for coding agents";
const LINKING_DOCS = ["claude-code-agent-teams", "multi-agent-teams", "agent-detection"];
// Mirrors SITE_URL in lib/site.ts without importing it, as check-seo.mjs does.
const apex = new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tmux-ide.com").origin;
const pageUrl = `${apex}${PATH}`;

if (!existsSync(resolve(appDir, "index.html"))) throw new Error("Run `next build` first");

const failures = [];
const fail = (message) => failures.push(message);
const read = (file) => {
  const path = resolve(appDir, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};
const decode = (text) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
const all = (text, pattern) => [...text.matchAll(pattern)].map((match) => decode(match[1]));
const linksHere = (html) => all(html, /<a\b[^>]*\bhref="([^"]*)"/gu).includes(PATH);

const page = read("tmux-for-coding-agents.html");
if (!page) {
  fail(`${PATH} is not a built page (.next/server/app/tmux-for-coding-agents.html is missing)`);
} else {
  const titles = all(page, /<title>([^<]*)<\/title>/gu);
  const title = titles[0] ?? "";
  if (titles.length !== 1) fail(`${PATH} must have one <title>, has ${titles.length}`);
  if (!title.startsWith(PHRASE)) fail(`${PATH} <title> must start with "${PHRASE}": "${title}"`);
  if (title.length > 60) fail(`${PATH} <title> is ${title.length} chars (max 60): "${title}"`);

  const description = all(page, /<meta name="description" content="([^"]*)"/gu)[0] ?? "";
  if (!description || description.length > 155)
    fail(`${PATH} meta description must be 1–155 chars, is ${description.length}`);

  const h1s = all(page, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gu).map((h1) => h1.replace(/<[^>]+>/gu, ""));
  if (h1s.length !== 1) fail(`${PATH} must have exactly one <h1>, has ${h1s.length}`);
  else if (!h1s[0].toLowerCase().includes(PHRASE))
    fail(`${PATH} <h1> must contain "${PHRASE}": "${h1s[0]}"`);

  const canonicals = all(page, /<link rel="canonical" href="([^"]*)"/gu);
  if (canonicals.length !== 1 || canonicals[0] !== pageUrl)
    fail(`${PATH} must have one canonical, ${pageUrl}; has [${canonicals.join(", ")}]`);
  const ogUrls = all(page, /<meta property="og:url" content="([^"]*)"/gu);
  if (ogUrls.length !== 1 || ogUrls[0] !== pageUrl)
    fail(`${PATH} must have one og:url, ${pageUrl}; has [${ogUrls.join(", ")}]`);
  if (/<meta name="robots" content="[^"]*noindex/u.test(page)) fail(`${PATH} must be indexable`);
}

const sitemap = read("sitemap.xml.body") ?? "";
if (!all(sitemap, /<loc>([^<]+)<\/loc>/gu).includes(pageUrl))
  fail(`The sitemap must list ${pageUrl}`);

const home = read("index.html") ?? "";
if (!linksHere(home)) fail(`The homepage must link to ${PATH}`);
for (const slug of LINKING_DOCS) {
  const html = read(`docs/${slug}.html`);
  if (!html) fail(`/docs/${slug} is not a built page`);
  else if (!linksHere(html)) fail(`/docs/${slug} must link to ${PATH}`);
}

const llms = read("llms.txt.body") ?? "";
if (!llms.includes(`](${pageUrl})`)) fail(`llms.txt must link to ${pageUrl}`);
const agentsManual = read("agents.md.body") ?? "";
if (!agentsManual.includes(pageUrl)) fail(`agents.md must link to ${pageUrl}`);

// The design mockup lived at /dev/tmux-for-coding-agents; it must not ship.
const appRoutes = JSON.parse(
  readFileSync(resolve(docsDir, ".next/app-path-routes-manifest.json"), "utf8"),
);
const devRoutes = Object.values(appRoutes).filter((route) => route.startsWith("/dev"));
if (devRoutes.length > 0) fail(`The /dev mockup routes must be gone: ${devRoutes.join(", ")}`);

if (failures.length > 0) {
  console.error(`Agents page check failed (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Agents page: ${PATH} built with its title, description, H1 and apex canonical; in the ` +
    `sitemap; linked from the homepage, ${LINKING_DOCS.length} docs pages, llms.txt and ` +
    "agents.md; no /dev mockup route.",
);
