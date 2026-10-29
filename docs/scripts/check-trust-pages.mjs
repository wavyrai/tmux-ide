import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFF_SITE_CASES } from "./off-site-cases.mjs";

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

// The Privacy page says the site loads nothing from other sites. Deny by default:
// an off-site URL anywhere in built HTML attributes, inline CSS or built CSS fails,
// unless the attribute only navigates or describes (a link, a form, metadata).
const filesUnder = (dir, extension) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
const NAVIGATION_RELS = new Set([
  "alternate",
  "author",
  "bookmark",
  "canonical",
  "external",
  "help",
  "license",
  "me",
  "nofollow",
  "noopener",
  "noreferrer",
  "opener",
  "pingback",
  "prev",
  "privacy-policy",
  "search",
  "sitemap",
  "tag",
  "terms-of-service",
]);
const absoluteUrls = (text) =>
  [...text.matchAll(/(?:^|[\s,("'=;:>])((?:https?:)?\/\/[^\s"'(),;<>]+)/giu)].map(
    (match) => match[1],
  );
const offSite = (url) => new URL(url, origin).origin !== origin;
// CSS escapes (`https\:\/\/`) unescaped; comments and @namespace (not a load) dropped.
const cssText = (css) =>
  css
    .replace(/\\([^0-9a-f\n])/giu, "$1")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/@namespace\b[^;]*;/giu, " ")
    .replace(/url\(\s*(["']?)data:[\s\S]*?\1\s*\)/giu, " ");
const navigationOnly = (tag, name, attributes) => {
  if (name.startsWith("data-") || name.startsWith("aria-") || name.startsWith("xmlns")) return true;
  if (
    ["title", "alt", "itemtype", "itemid", "itemprop", "cite", "action", "formaction"].includes(
      name,
    )
  )
    return true;
  if (name === "href" && ["a", "area"].includes(tag)) return true;
  if (name === "content" && tag === "meta")
    return !/^refresh$/iu.test(attributes["http-equiv"] ?? "");
  if (name === "href" && tag === "link") {
    const rels = (attributes.rel ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    return rels.length > 0 && rels.every((rel) => NAVIGATION_RELS.has(rel));
  }
  return false;
};
const htmlLoads = (html) => {
  const urls = [];
  for (const [tagText, rawName] of html.matchAll(
    /<([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu,
  )) {
    const tag = rawName.toLowerCase();
    const attributes = {};
    for (const match of tagText.matchAll(
      /\s([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu,
    ))
      attributes[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
    for (const [name, value] of Object.entries(attributes)) {
      if (navigationOnly(tag, name, attributes)) continue;
      if (name === "srcdoc") urls.push(...htmlLoads(value));
      else if (!/^\s*data:/iu.test(value))
        urls.push(...absoluteUrls(name === "style" ? cssText(value) : value));
    }
  }
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu))
    urls.push(...absoluteUrls(cssText(css)));
  // Script bodies are code (N8: runtime loads), except the two JSON types the browser acts on.
  for (const [, json] of html.matchAll(
    /<script\b[^>]*\stype="(?:speculationrules|importmap)"[^>]*>([\s\S]*?)<\/script>/giu,
  ))
    urls.push(...absoluteUrls(json));
  return urls;
};
// The guard against its catalogue: every "fail" case must report an off-site load
// and every "pass" case must not, before the built output is trusted to it.
for (const testCase of OFF_SITE_CASES) {
  const urls =
    testCase.kind === "html" ? htmlLoads(testCase.input) : absoluteUrls(cssText(testCase.input));
  const got = urls.some(offSite) ? "fail" : "pass";
  if (got !== testCase.expect)
    fail(
      `off-site guard case ${testCase.id} (${testCase.what}): expected ${testCase.expect}, got ${got}`,
    );
}

const loadSources = [
  ...filesUnder(appDir, ".html").map((file) => [file, htmlLoads(readFileSync(file, "utf8"))]),
  ...filesUnder(resolve(docsDir, ".next/static"), ".css").map((file) => [
    file,
    absoluteUrls(cssText(readFileSync(file, "utf8"))),
  ]),
];
for (const [file, urls] of loadSources) {
  for (const url of new Set(urls.filter(offSite)))
    fail(`${relative(resolve(docsDir, ".next"), file)} loads ${url} from another site`);
}

if (failures.length > 0) {
  console.error(`Trust pages check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Trust pages verified: ${trustPaths.join(", ")} each have ≥ ${minMainText} characters in <main>, ` +
    `a self-canonical on ${origin}, title and description within limits, a sitemap entry and ` +
    `footer links from the homepage and docs, and no email address; /contact links GitHub issues and security advisories; no built page or stylesheet references a load from another site.`,
);
