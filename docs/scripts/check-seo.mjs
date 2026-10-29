import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_REDIRECTS } from "../lib/legacy-redirects.mjs";
import { sourcesForPath } from "./git-date-sources.mjs";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const docsHtml = readFileSync(resolve(appDir, "docs/getting-started.html"), "utf8");
const robots = readFileSync(resolve(appDir, "robots.txt.body"), "utf8");
const sitemap = readFileSync(resolve(appDir, "sitemap.xml.body"), "utf8");
const routes = JSON.parse(readFileSync(resolve(docsDir, ".next/routes-manifest.json"), "utf8"));
const llmsIndex = readFileSync(resolve(appDir, "llms.txt.body"), "utf8");
const llmsFull = readFileSync(resolve(appDir, "llms-full.txt.body"), "utf8");
const socialCard = readFileSync(resolve(docsDir, "components/social-card.tsx"), "utf8");

const requiredHtml = [
  '<link rel="canonical"',
  'property="og:title"',
  'property="og:description"',
  'property="og:image"',
  'name="twitter:card"',
  'type="application/ld+json"',
  '"@type":"Organization"',
  '"@type":"WebSite"',
  '"@type":"SoftwareApplication"',
  '"@type":"SoftwareSourceCode"',
  '"@type":"FAQPage"',
  '"@id":"https://www.prototyper.co/#organization"',
  '"license":"https://spdx.org/licenses/MIT.html"',
];
for (const marker of requiredHtml) {
  if (!html.includes(marker)) throw new Error(`Built homepage is missing SEO marker: ${marker}`);
}

// One canonical host everywhere: canonical, og:url, JSON-LD, sitemap, robots, llms.txt.
const canonicalOrigin = new URL(
  html.match(/<link rel="canonical" href="([^"]+)"/u)?.[1] ?? "invalid:",
).origin;
if (!canonicalOrigin.startsWith("https://"))
  throw new Error(`Homepage canonical is not an absolute https URL: ${canonicalOrigin}`);
const siteUrls = (text) =>
  [...text.matchAll(/https?:\/\/(?:www\.)?tmux-ide\.com/gu)].map((match) => match[0]);
for (const [name, text] of [
  ["homepage", html],
  ["docs page", docsHtml],
  ["robots.txt", robots],
  ["sitemap", sitemap],
  ["llms.txt", llmsIndex],
]) {
  const stray = siteUrls(text).find((url) => url !== canonicalOrigin);
  if (stray)
    throw new Error(`${name} references ${stray}; the canonical host is ${canonicalOrigin}`);
}

if (/<title>[^<]*\| tmux-ide<\/title>/u.test(html) && /<title>tmux-ide[^<]*\|/u.test(html))
  throw new Error("Homepage title repeats the brand through the title template");

if (!/^# tmux-ide\n\n> \S/u.test(llmsIndex))
  throw new Error("llms.txt must start with '# tmux-ide' and a '>' summary");
if (/\]\(\//u.test(llmsIndex)) throw new Error("llms.txt links must be absolute URLs");
// Markdown served to agents (llms-full.txt and the .md twins share one
// renderer) must not leak MDX components outside code fences.
const outsideFences = llmsFull.replace(/```[\s\S]*?```/gu, "");
const leaked = outsideFences.match(/^[ \t]*<\/?[A-Z][A-Za-z]*[\s/>]/mu);
if (leaked) throw new Error(`llms-full.txt leaks an MDX component: ${leaked[0].trim()}`);
const headingId = outsideFences.match(/^#{1,6} .* \[#[\w-]+\]$/mu);
if (headingId) throw new Error(`llms-full.txt leaks fumadocs heading-id syntax: ${headingId[0]}`);
// Every same-site page llms.txt points agents at must be a built route.
for (const [, href] of llmsIndex.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)) {
  const url = new URL(href);
  if (url.origin !== canonicalOrigin) continue;
  const route = url.pathname.replace(/^\/+|\/+$/gu, "") || "index";
  const built = [`${route}.html`, `${route}.body`].some((file) =>
    existsSync(resolve(appDir, file)),
  );
  if (!built) throw new Error(`llms.txt links to ${href}, which is not a built route`);
}

for (const marker of ["ascii-wordmark.svg", "icon-dark.png", 'background: "#0d0d10"']) {
  if (!socialCard.includes(marker)) {
    throw new Error(`Shared social card is missing dark-mode brand marker: ${marker}`);
  }
}

if (!/rel="canonical" href="[^"]+\/docs\/getting-started"/u.test(docsHtml)) {
  throw new Error("Built docs page is missing its route-specific canonical URL");
}

for (const marker of [
  'property="og:type" content="article"',
  'property="og:image:width" content="1200"',
  'property="og:image:height" content="630"',
  'name="twitter:creator" content="@prototyper_co"',
  '"@type":"TechArticle"',
  '"@type":"BreadcrumbList"',
  // Git-backed dates exist only when the build host has full history; a shallow
  // clone omits them rather than guessing (see generate-git-dates.mjs).
  ...(isFullHistory() ? ['"dateModified":"', '"datePublished":"'] : []),
  'rel="alternate" type="text/markdown" href="',
]) {
  if (!docsHtml.includes(marker))
    throw new Error(`Built docs page is missing SEO marker: ${marker}`);
}

for (const marker of ["User-Agent: *", "Allow: /", "Sitemap:", "Host:"]) {
  if (!robots.includes(marker)) throw new Error(`Built robots.txt is missing: ${marker}`);
}
// Owner policy: search, AI answers and AI training are all allowed. The signal
// must sit inside the `*` group, and nothing may block the whole site.
const wildcardGroup = robots
  .split(/\n(?=User-Agent:)/iu)
  .find((group) => /^User-Agent: \*$/imu.test(group));
if (!/^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/mu.test(wildcardGroup ?? ""))
  throw new Error(
    "robots.txt `*` group must carry Content-Signal: search=yes, ai-input=yes, ai-train=yes",
  );
if (/^Disallow: \/\s*$/mu.test(robots))
  throw new Error("robots.txt must not disallow the whole site");

const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
if (locations.length === 0) throw new Error("Built sitemap has no locations");
if (new Set(locations).size !== locations.length)
  throw new Error("Built sitemap has duplicate URLs");
if (!locations.some((location) => /\/$/u.test(location)))
  throw new Error("Built sitemap does not contain the canonical homepage URL");
if (!locations.some((location) => /\/docs(?:\/|$)/u.test(location)))
  throw new Error("Built sitemap does not contain documentation URLs");
// <lastmod> must be exactly the last commit time of the URL's source files
// (re-derived here with `git log -1 -- <sources>`), never the build time. Dates
// a shallow clone cannot back are omitted, so only check entries that have one.
const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => ({
  loc: match[1].match(/<loc>([^<]+)<\/loc>/u)?.[1],
  lastmod: match[1].match(/<lastmod>([^<]+)<\/lastmod>/u)?.[1],
}));
for (const { loc, lastmod } of entries) {
  if (!lastmod) continue;
  const sources = sourcesForPath(new URL(loc).pathname);
  if (!sources) throw new Error(`Sitemap URL has a lastmod but no known source: ${loc}`);
  const expected = git(["log", "-1", "--format=%cI", "--", ...sources]);
  if (!expected || Date.parse(expected) !== Date.parse(lastmod))
    throw new Error(
      `Sitemap lastmod is not the source's last commit time: ${loc} ${lastmod} ` +
        `(git: ${expected || "no commit"} for ${sources.join(", ")})`,
    );
}
const dated = entries.filter((entry) => entry.lastmod).length;
if (isFullHistory() && dated !== entries.length)
  throw new Error(
    `Sitemap is missing lastmod for ${entries.length - dated} URL(s) despite full git history`,
  );

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: docsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
function isFullHistory() {
  return git(["rev-parse", "--is-shallow-repository"]) === "false";
}

// Every built page: a <title> of at most 60 characters, unique across the
// site, and a meta description of at most 155. noindex pages stay out of the
// sitemap, and every page in the sitemap is indexable. Next's own error
// documents are not URLs anyone can link to, so they are left out.
const nextErrorDocuments = new Set(["_not-found.html", "_global-error.html"]);
const builtPages = readdirSync(appDir, { recursive: true })
  .filter((file) => file.endsWith(".html") && !nextErrorDocuments.has(file))
  .sort()
  .map((file) => [
    file === "index.html" ? "/" : `/${file.slice(0, -5)}`,
    readFileSync(resolve(appDir, file), "utf8"),
  ]);
const decode = (text) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
const titleOwners = new Map();
const sitemapPaths = new Set(
  locations.map((location) => new URL(location).pathname.replace(/(.)\/$/u, "$1")),
);
for (const [path, page] of builtPages) {
  const title = decode(page.match(/<title>([^<]*)<\/title>/u)?.[1] ?? "");
  if (!title) throw new Error(`${path} has no <title>`);
  if (title.length > 60)
    throw new Error(`${path} <title> is ${title.length} chars (max 60): ${title}`);
  if (titleOwners.has(title))
    throw new Error(`${path} and ${titleOwners.get(title)} share the <title> "${title}"`);
  titleOwners.set(title, path);
  const description = decode(page.match(/<meta name="description" content="([^"]*)"/u)?.[1] ?? "");
  if (!description || description.length > 155)
    throw new Error(`${path} meta description must be 1–155 chars (is ${description.length})`);
  const published = page.match(/"datePublished":"([^"]+)"/u)?.[1];
  const modified = page.match(/"dateModified":"([^"]+)"/u)?.[1];
  if (published && modified && Date.parse(published) > Date.parse(modified))
    throw new Error(`${path} datePublished ${published} is after dateModified ${modified}`);
  const noindex = /<meta name="robots" content="noindex/u.test(page);
  if (noindex && sitemapPaths.has(path))
    throw new Error(`${path} is noindex but listed in the sitemap`);
  if (!noindex && !sitemapPaths.has(path))
    throw new Error(`${path} is indexable but missing from the sitemap`);
}

// Search ranking (#640). Google ranked www and apex copies of the same pages,
// so every page names exactly one URL for itself, on the apex host. The
// expected origin mirrors SITE_URL in lib/site.ts without importing it, so a
// wrong default there fails here.
const apexOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tmux-ide.com")
  .origin;
const ownUrl = (href, path) => {
  try {
    const url = new URL(decode(href));
    return (
      url.origin === apexOrigin &&
      url.pathname.replace(/(.)\/$/u, "$1") === path &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};
const rankingProblems = [];
for (const [path, page] of builtPages) {
  const canonicals = [...page.matchAll(/<link rel="canonical" href="([^"]*)"/gu)].map((m) => m[1]);
  if (canonicals.length !== 1 || !ownUrl(canonicals[0], path))
    rankingProblems.push(
      `${path} must have one canonical, ${apexOrigin}${path === "/" ? "" : path}; has [${canonicals.join(", ")}]`,
    );
  const ogUrls = [...page.matchAll(/<meta property="og:url" content="([^"]*)"/gu)].map((m) => m[1]);
  if (ogUrls.length !== 1 || !ownUrl(ogUrls[0], path))
    rankingProblems.push(
      `${path} must have one og:url on its own apex URL; has [${ogUrls.join(", ")}]`,
    );
}
for (const location of locations) {
  if (new URL(location).origin !== apexOrigin)
    rankingProblems.push(`Sitemap URL ${location} is not on ${apexOrigin}`);
}
// The exact phrase "tmux for coding agents" as a title belongs to the
// /tmux-for-coding-agents landing page (#643); docs pages must not compete for it.
const agentsPhrase = /tmux for coding agents/iu;
for (const [path, page] of builtPages) {
  if (!path.startsWith("/docs")) continue;
  for (const pattern of [
    /<title>([^<]*)<\/title>/u,
    /<meta property="og:title" content="([^"]*)"/u,
  ]) {
    const title = decode(page.match(pattern)?.[1] ?? "");
    if (agentsPhrase.test(title))
      rankingProblems.push(
        `${path} title uses "tmux for coding agents", which #643's page owns: ${title}`,
      );
  }
}
const homeTitle = decode(html.match(/<title>([^<]*)<\/title>/u)?.[1] ?? "");
const homeDescription = decode(
  html.match(/<meta name="description" content="([^"]*)"/u)?.[1] ?? "",
);
if (!homeTitle.startsWith("tmux-ide"))
  rankingProblems.push(`Homepage title must lead with the brand "tmux-ide": ${homeTitle}`);
for (const phrase of ["terminal multiplexer", "coding agents"]) {
  if (!homeTitle.toLowerCase().includes(phrase))
    rankingProblems.push(`Homepage title must name "${phrase}": ${homeTitle}`);
}
for (const phrase of ["tmux for coding agents", "terminal multiplexer", "Claude Code", "Codex"]) {
  if (!homeDescription.toLowerCase().includes(phrase.toLowerCase()))
    rankingProblems.push(`Homepage description must name "${phrase}": ${homeDescription}`);
}
if (rankingProblems.length > 0)
  throw new Error(`Search ranking checks failed:\n- ${rankingProblems.join("\n- ")}`);

// Links from the homepage into the docs live in TypeScript, out of reach of
// check:product-docs, so verify each target page and #anchor here.
const builtPagesByPath = new Map(builtPages);
for (const [, href] of html.matchAll(/href="(\/docs[^"]*)"/gu)) {
  const [path, anchor] = href.split("#");
  const target = builtPagesByPath.get(path.replace(/(.)\/$/u, "$1"));
  if (!target) throw new Error(`Homepage links to ${href}, which is not a built docs page`);
  if (anchor && !target.includes(`id="${anchor}"`))
    throw new Error(`Homepage links to ${href}, but that page has no #${anchor} heading`);
}

// Retired docs URLs: every redirect lands on a built page, never on another
// redirect, and no redirect shadows a page that still exists.
for (const [source, destination] of Object.entries(LEGACY_REDIRECTS)) {
  if (builtPagesByPath.has(source))
    throw new Error(`Redirect source ${source} is still a built page; remove the redirect`);
  if (!builtPagesByPath.has(destination))
    throw new Error(`Redirect ${source} → ${destination} does not land on a built page`);
}
const configuredRedirects = new Set(
  routes.redirects.filter((route) => route.statusCode === 308).map((route) => route.source),
);
for (const source of Object.keys(LEGACY_REDIRECTS)) {
  if (!configuredRedirects.has(source))
    throw new Error(`Legacy redirect ${source} is not served as a permanent redirect`);
}

const headerKeys = new Set(
  routes.headers.flatMap((route) => route.headers.map((header) => header.key.toLowerCase())),
);
for (const key of [
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options",
  "content-security-policy",
  "cross-origin-opener-policy",
  "permissions-policy",
]) {
  if (!headerKeys.has(key)) throw new Error(`Security header is not emitted: ${key}`);
}

console.log(
  `SEO artifacts verified: metadata + entity graph + visible FAQ schema, security headers, ` +
    `robots.txt (Content-Signal), llms.txt, ${builtPages.length} unique page titles, one canonical host (${canonicalOrigin}), and ${locations.length} ` +
    `sitemap URLs (${dated} with source-backed lastmod).`,
);
