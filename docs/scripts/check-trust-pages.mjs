import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The About, Contact and Privacy pages that tell people and agents who runs
// tmux-ide.com and how to reach them. Each must be a real, indexable page with
// enough text to say something, reachable from every page's footer.

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const origin = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tmux-ide.com").replace(
  /\/+$/u,
  "",
);
const repository = "https://github.com/wavyrai/tmux-ide";
const trustPaths = ["/about", "/contact", "/privacy"];
const minMainText = 500;

const failures = [];
const fail = (message) => failures.push(message);

const read = (file) => {
  const path = resolve(appDir, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};
const decode = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec) => String.fromCodePoint(Number(dec)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
/** Visible text of an HTML fragment: no scripts, styles or tags, whitespace collapsed. */
const visibleText = (fragment) =>
  decode(
    fragment
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<template\b[\s\S]*?<\/template>/giu, " ")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/\s+/gu, " ")
    .trim();
const between = (html, tag) => html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}>`, "u"));
const hrefs = (fragment) =>
  [...fragment.matchAll(/\bhref="([^"]*)"/gu)].map((match) => decode(match[1]));

const sitemap = read("sitemap.xml.body") ?? "";
const locations = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]));

const emailPattern = /mailto:|[\w.+-]+@[\w-]+\.[a-z]{2,}/iu;

const footerPages = [
  ["homepage", read("index.html")],
  ["docs page", read("docs/getting-started.html")],
];

for (const path of trustPaths) {
  const html = read(`${path.slice(1)}.html`);
  if (html === null) {
    fail(`${path} is not a built page (.next/server/app${path}.html is missing)`);
    continue;
  }

  const main = between(html, "main");
  if (!main) fail(`${path} has no <main> element`);
  else {
    // The (home) layout renders the site nav and footer inside <main>; their text is not the page's.
    const pageOnly = main[1]
      .replace(/<header id="nd-nav"[\s\S]*?<\/header>/u, " ")
      .replace(/<footer\b[\s\S]*<\/footer>/u, " ");
    const length = visibleText(pageOnly).length;
    if (length < minMainText)
      fail(`${path} has ${length} characters of visible text in <main> (min ${minMainText})`);
    // PM decision: no email address on any trust page, as text or as a link.
    if (emailPattern.test(`${visibleText(main[1])} ${hrefs(main[1]).join(" ")}`))
      fail(`${path} shows an email address; contact goes through GitHub`);
  }

  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/u)?.[1];
  if (canonical !== `${origin}${path}`)
    fail(`${path} canonical is ${canonical ?? "missing"}, expected ${origin}${path}`);

  const title = decode(html.match(/<title>([^<]*)<\/title>/u)?.[1] ?? "");
  if (!title || title.length > 60) fail(`${path} <title> must be 1–60 chars (is ${title.length})`);
  const description = decode(html.match(/<meta name="description" content="([^"]*)"/u)?.[1] ?? "");
  if (!description || description.length > 155)
    fail(`${path} meta description must be 1–155 chars (is ${description.length})`);
  if (/<meta name="robots" content="noindex/u.test(html)) fail(`${path} is noindex`);

  if (!locations.has(`${origin}${path}`)) fail(`${path} is missing from the sitemap`);

  for (const [name, page] of footerPages) {
    const footer = page && between(page, "footer");
    if (!footer) fail(`${name} has no <footer>`);
    else if (!hrefs(footer[1]).includes(path)) fail(`${name} footer does not link to ${path}`);
  }
}

const contact = read("contact.html");
if (contact) {
  const links = hrefs(between(contact, "main")?.[1] ?? "");
  if (!links.some((href) => href.startsWith(`${repository}/issues`)))
    fail(`/contact does not link to GitHub issues (${repository}/issues…)`);
  if (!links.some((href) => href.startsWith(`${repository}/security/advisories`)))
    fail(
      `/contact does not link to GitHub Security Advisories (${repository}/security/advisories)`,
    );
}

// The Privacy page says the site loads nothing from other sites: no built page or
// stylesheet may pull a script, stylesheet, font, image, media, frame, preload or
// icon from another origin.
const filesUnder = (dir, extension) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
const LOADING_RELS = new Set([
  "stylesheet",
  "preload",
  "modulepreload",
  "prefetch",
  "preconnect",
  "dns-prefetch",
  "icon",
  "apple-touch-icon",
  "mask-icon",
  "manifest",
]);
const attribute = (tag, name) =>
  tag
    .match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "iu"))
    ?.slice(1)
    .find(Boolean);
// @import "x", @import url(x) and url(x) targets in CSS text.
const cssUrls = (css) =>
  [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)|url\(\s*["']?([^"')\s]+)/giu)].map(
    (match) => match[1] ?? match[2],
  );
const htmlUrls = (html) => {
  const urls = [];
  for (const [tag] of html.matchAll(/<[a-z][\w:-]*\b[^>]*>/giu)) {
    for (const name of ["src", "poster", "data"]) {
      const value = attribute(tag, name);
      if (value) urls.push(value);
    }
    const srcset = attribute(tag, "srcset");
    if (srcset) urls.push(...srcset.split(",").map((part) => part.trim().split(/\s+/u)[0]));
    if (/^<(?:image|use|feimage)\b/iu.test(tag))
      urls.push(attribute(tag, "href") ?? "", attribute(tag, "xlink:href") ?? "");
    if (/^<link\b/iu.test(tag)) {
      const rels = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/u);
      if (rels.some((rel) => LOADING_RELS.has(rel))) urls.push(attribute(tag, "href") ?? "");
    }
    const style = attribute(tag, "style");
    if (style) urls.push(...cssUrls(style));
  }
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu))
    urls.push(...cssUrls(css));
  return urls;
};
const offSite = (url) => {
  if (!/^(?:https?:)?\/\//iu.test(url.trim())) return false;
  return new URL(url.trim(), origin).origin !== origin;
};
const loadSources = [
  ...filesUnder(appDir, ".html").map((file) => [file, htmlUrls(readFileSync(file, "utf8"))]),
  ...filesUnder(resolve(docsDir, ".next/static"), ".css").map((file) => [
    file,
    cssUrls(readFileSync(file, "utf8")),
  ]),
];
for (const [file, urls] of loadSources) {
  for (const url of urls.filter(offSite))
    fail(`${relative(resolve(docsDir, ".next"), file)} loads ${url} from another site`);
}

if (failures.length > 0) {
  console.error(`Trust pages check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Trust pages verified: ${trustPaths.join(", ")} each have ≥ ${minMainText} characters in <main>, ` +
    `a self-canonical on ${origin}, title and description within limits, a sitemap entry and ` +
    `footer links from the homepage and docs, and no email address; /contact links GitHub issues and security advisories; no built page loads anything from another site.`,
);
