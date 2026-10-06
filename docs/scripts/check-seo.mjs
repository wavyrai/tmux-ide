import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcesForPath } from "./git-date-sources.mjs";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const docsHtml = readFileSync(resolve(appDir, "docs/getting-started.html"), "utf8");
const robots = readFileSync(resolve(appDir, "robots.txt.body"), "utf8");
const sitemap = readFileSync(resolve(appDir, "sitemap.xml.body"), "utf8");
const routes = JSON.parse(readFileSync(resolve(docsDir, ".next/routes-manifest.json"), "utf8"));
const llmsIndex = readFileSync(resolve(appDir, "llms.txt.body"), "utf8");
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
  '"dateModified":"',
  'rel="alternate" type="text/markdown" href="',
]) {
  if (!docsHtml.includes(marker))
    throw new Error(`Built docs page is missing SEO marker: ${marker}`);
}

for (const marker of ["User-Agent: *", "Allow: /", "Sitemap:", "Host:"]) {
  if (!robots.includes(marker)) throw new Error(`Built robots.txt is missing: ${marker}`);
}

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
    `robots.txt, llms.txt, one canonical host (${canonicalOrigin}), and ${locations.length} ` +
    `sitemap URLs (${dated} with source-backed lastmod).`,
);
