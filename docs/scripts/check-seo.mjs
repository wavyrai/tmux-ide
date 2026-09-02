import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const docsHtml = readFileSync(resolve(appDir, "docs/getting-started.html"), "utf8");
const robots = readFileSync(resolve(appDir, "robots.txt.body"), "utf8");
const sitemap = readFileSync(resolve(appDir, "sitemap.xml.body"), "utf8");
const routes = JSON.parse(readFileSync(resolve(docsDir, ".next/routes-manifest.json"), "utf8"));
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
  '"@type":"FAQPage"',
];
for (const marker of requiredHtml) {
  if (!html.includes(marker)) throw new Error(`Built homepage is missing SEO marker: ${marker}`);
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
if (sitemap.includes("<lastmod>"))
  throw new Error("Sitemap dates must be source-backed; unstable build-time dates are forbidden");

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
    `robots.txt, and ${locations.length} stable sitemap URLs.`,
);
