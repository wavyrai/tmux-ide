// Serves the built site with `next start` and checks the round-2 agent-readiness
// files (#650): /pricing.md and its llms.txt link, the robots.txt schemamap
// line with its Schema Map and JSONL feed (NLWeb Schema Feeds 0.1), and the
// trustManifest on every ard.json and ai-catalog.json entry. Run after `next build`.
// CHECK_PORT picks the port; without it the OS picks a free one.
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tmux-ide.com").replace(
  /\/+$/u,
  "",
);
const PUBLISHER_DOMAIN = "tmux-ide.com";
const REPO = "https://github.com/wavyrai/tmux-ide";

const failures = [];
const fail = (assertion, message) => failures.push(`[${assertion}] ${message}`);

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const port = process.env.CHECK_PORT ? Number(process.env.CHECK_PORT) : await freePort();
const origin = `http://127.0.0.1:${port}`;
const next = spawn(
  resolve(docsDir, "node_modules/.bin/next"),
  ["start", "-p", String(port), "-H", "127.0.0.1"],
  { cwd: docsDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port) } },
);
let serverLog = "";
next.stdout.on("data", (chunk) => (serverLog += chunk));
next.stderr.on("data", (chunk) => (serverLog += chunk));
const stop = () => {
  if (next.exitCode === null) next.kill("SIGTERM");
};
process.on("exit", stop);
const watchdog = setTimeout(() => {
  console.error("check-agent-readiness-r2: timed out after 120 s");
  console.error(serverLog);
  stop();
  process.exit(1);
}, 120_000);

async function waitForServer() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (next.exitCode !== null) throw new Error(`next start exited early:\n${serverLog}`);
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      await response.arrayBuffer();
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  throw new Error(`next start did not answer on ${origin}:\n${serverLog}`);
}

/** Site paths and same-site absolute URLs are requested from the local server. */
async function get(pathOrUrl) {
  const path = pathOrUrl.startsWith(`${siteUrl}/`) ? pathOrUrl.slice(siteUrl.length) : pathOrUrl;
  if (!path.startsWith("/")) throw new Error(`${pathOrUrl} is not on ${siteUrl}`);
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

const essence = (contentType) => contentType.split(";")[0].trim().toLowerCase();

/** A route that must answer 200 with one of the given media types; its body, or undefined. */
async function fetchTyped(assertion, path, types) {
  const response = await get(path);
  if (response.status !== 200) {
    fail(`${assertion}-200`, `${path} returned ${response.status}, expected 200`);
    return undefined;
  }
  if (!types.includes(essence(response.type)))
    fail(
      `${assertion}-type`,
      `${path} has Content-Type "${response.type}", expected ${types.join(" or ")}`,
    );
  return response.body;
}

const isApexUrl = (value) => {
  try {
    const url = new URL(value);
    return url.origin === siteUrl;
  } catch {
    return false;
  }
};

/** The host of an identity URI (an HTTPS URI or did:web), or undefined. */
function identityHost(value) {
  if (typeof value !== "string") return undefined;
  const didWeb = /^did:web:([^:]+)/u.exec(value);
  if (didWeb) return decodeURIComponent(didWeb[1]);
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** The ld+json blocks of an HTML page, parsed. */
function jsonLdNodes(html) {
  return [
    ...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gu),
  ].flatMap((match) => {
    const value = JSON.parse(match[1]);
    return Array.isArray(value["@graph"]) ? value["@graph"] : [value];
  });
}

async function checkPricing() {
  const body = await fetchTyped("pricing", "/pricing.md", ["text/markdown"]);
  if (body !== undefined) {
    if (!body.startsWith("# "))
      fail(
        "pricing-heading",
        `/pricing.md must start with "# ", starts with ${JSON.stringify(body.slice(0, 20))}`,
      );
    if (!/\bfree\b/iu.test(body)) fail("pricing-free", "/pricing.md does not say tmux-ide is free");
    if (!/\bMIT\b/u.test(body)) fail("pricing-mit", "/pricing.md does not name the MIT license");
    if (!body.includes(`${REPO}/blob/main/LICENSE`))
      fail("pricing-license-url", `/pricing.md does not link ${REPO}/blob/main/LICENSE`);
  }
  const llms = await get("/llms.txt");
  if (!llms.body.includes(`](${siteUrl}/pricing.md)`))
    fail("llms-pricing-link", `/llms.txt does not link ${siteUrl}/pricing.md`);
}

async function sitemapDocsUrls() {
  const { body } = await get("/sitemap.xml");
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)]
    .map((match) => match[1])
    .filter((url) => url === `${siteUrl}/docs` || url.startsWith(`${siteUrl}/docs/`));
}

async function checkSchemaFeeds() {
  const robots = await get("/robots.txt");
  // NLWeb Schema Feeds §3.3: the directive is case-insensitive and its URL absolute.
  const schemamaps = [...robots.body.matchAll(/^schemamap:[ \t]*(\S+)[ \t]*$/gimu)].map(
    (m) => m[1],
  );
  if (schemamaps.length === 0) {
    fail("robots-schemamap", "robots.txt has no schemamap: line");
    return;
  }
  for (const url of schemamaps)
    if (!isApexUrl(url))
      fail("robots-schemamap", `schemamap ${url} is not an absolute URL on ${siteUrl}`);

  const feeds = [];
  for (const url of schemamaps.filter(isApexUrl)) {
    const xml = await fetchTyped("schemamap", url, ["application/xml", "text/xml"]);
    if (xml === undefined) continue;
    if (!/<urlset[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/u.test(xml))
      fail("schemamap-format", `${url} is not a sitemap-format <urlset>`);
    for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/gu)) {
      const loc = /<loc>([^<]+)<\/loc>/u.exec(block)?.[1];
      const contentType = /<sf:contentType>([^<]+)<\/sf:contentType>/u.exec(block)?.[1];
      if (!loc || !contentType)
        fail("schemamap-format", `${url} has a <url> without <loc> or <sf:contentType>`);
      else if (contentType === "structuredData/schema.org") feeds.push(loc);
    }
  }
  if (feeds.length === 0) {
    fail("schemamap-feed", "no Schema Map lists a structuredData/schema.org feed");
    return;
  }

  const nodes = [];
  for (const feed of feeds) {
    if (!isApexUrl(feed)) {
      fail("feed-apex", `feed ${feed} is not on ${siteUrl}`);
      continue;
    }
    const body = await fetchTyped("feed", feed, ["application/x-jsonlines", "application/jsonl"]);
    if (body === undefined) continue;
    const lines = body.split("\n");
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((line, index) => {
      let node;
      try {
        node = JSON.parse(line);
      } catch (error) {
        fail("feed-line-json", `${feed} line ${index + 1} is not JSON: ${error.message}`);
        return;
      }
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        fail("feed-line-json", `${feed} line ${index + 1} is not a JSON object`);
        return;
      }
      if (node["@context"] !== "https://schema.org" || typeof node["@type"] !== "string")
        fail(
          "feed-line-schema",
          `${feed} line ${index + 1} lacks @context https://schema.org or @type`,
        );
      const id = node.url ?? node["@id"];
      if (typeof id !== "string" || !isApexUrl(id))
        fail("feed-apex", `${feed} line ${index + 1} url ${id} is not on ${siteUrl}`);
      nodes.push(node);
    });
  }

  // One TechArticle per indexable docs page: exactly the sitemap's /docs URLs.
  const articles = nodes.filter((node) => node["@type"] === "TechArticle");
  const articleUrls = articles.map((node) => node.url);
  const docsUrls = await sitemapDocsUrls();
  if (docsUrls.length === 0) fail("feed-docs-coverage", "the sitemap lists no /docs URLs");
  const duplicates = articleUrls.filter((url, index) => articleUrls.indexOf(url) !== index);
  if (duplicates.length) fail("feed-docs-coverage", `feed repeats ${duplicates.join(", ")}`);
  for (const url of docsUrls)
    if (!articleUrls.includes(url))
      fail("feed-docs-coverage", `feed has no TechArticle for ${url}`);
  for (const url of articleUrls)
    if (!docsUrls.includes(url))
      fail("feed-docs-coverage", `feed lists ${url}, which the sitemap does not`);

  // Schema Feeds §7.1: each line is the node its page's own JSON-LD carries.
  for (const article of articles.filter((node) => docsUrls.includes(node.url))) {
    const page = await get(article.url);
    const onPage = jsonLdNodes(page.body).find((node) => node["@type"] === "TechArticle");
    const { "@context": _context, ...fromFeed } = article;
    if (!isDeepStrictEqual(onPage, fromFeed))
      fail("feed-matches-page", `${article.url}: feed TechArticle differs from the page's JSON-LD`);
  }
  const home = await get("/");
  const software = jsonLdNodes(home.body).find((node) => node["@type"] === "SoftwareApplication");
  const softwareLine = nodes.find((node) => node["@type"] === "SoftwareApplication");
  if (softwareLine) {
    const { "@context": _context, ...fromFeed } = softwareLine;
    if (!isDeepStrictEqual(software, fromFeed))
      fail("feed-matches-page", "feed SoftwareApplication differs from the homepage's JSON-LD");
  }
}

/** The publisher segment of a urn:air identifier. */
const publisherOf = (identifier) => /^urn:air:([^:]+):/u.exec(identifier ?? "")?.[1];

function checkArdTrust(label, entry) {
  const manifest = entry.trustManifest;
  if (manifest === null || typeof manifest !== "object") {
    fail("trust-manifest", `${label} has no trustManifest`);
    return;
  }
  const host = identityHost(manifest.identity);
  if (host !== PUBLISHER_DOMAIN)
    fail(
      "trust-identity",
      `${label} trustManifest.identity ${manifest.identity} does not name ${PUBLISHER_DOMAIN}`,
    );
  if (host !== publisherOf(entry.identifier))
    fail("trust-identity", `${label} trustManifest.identity does not match the urn:air publisher`);
  checkIdentityOnly(label, "trustManifest", manifest);
}

/** Identity only (lead's design call on #650): no attestations or signatures we don't have. */
function checkIdentityOnly(label, member, manifest) {
  for (const key of ["attestations", "signature", "additionalSignatures", "trustSchema"])
    if (key in manifest) fail("trust-identity-only", `${label} ${member} carries ${key}`);
  const sources = (manifest.provenance ?? []).map((link) => link.sourceId);
  if (!sources.includes(REPO))
    fail("trust-provenance", `${label} ${member} does not link the source repository ${REPO}`);
}

function checkAiCatalogTrust(label, entry) {
  const manifests = entry.trustManifests;
  if (!Array.isArray(manifests) || manifests.length === 0) {
    fail("trust-manifests", `${label} has no trustManifests`);
    return;
  }
  for (const manifest of manifests) {
    if (identityHost(manifest.contributor) !== PUBLISHER_DOMAIN)
      fail(
        "trust-identity",
        `${label} trustManifests contributor ${manifest.contributor} does not name ${PUBLISHER_DOMAIN}`,
      );
    // AI Catalog 1.0 "Manifest Validity": a contributor alone is not a manifest.
    if (
      !["provenance", "attestations"].some((key) => manifest[key]?.length) &&
      !manifest.trustSchema &&
      !manifest.signature
    )
      fail(
        "trust-manifests",
        `${label} trustManifests entry has no trust member besides contributor`,
      );
    checkIdentityOnly(label, "trustManifests", manifest);
  }
}

async function checkTrustManifests() {
  for (const [path, perEntry] of [
    ["/.well-known/ard.json", [checkArdTrust]],
    ["/.well-known/ai-catalog.json", [checkArdTrust, checkAiCatalogTrust]],
  ]) {
    const { body } = await get(path);
    const entries = JSON.parse(body).entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      fail("trust-manifest", `${path} has no entries`);
      continue;
    }
    for (const entry of entries)
      for (const check of perEntry) check(`${path} entry ${entry.identifier}`, entry);
  }
}

try {
  await waitForServer();
  await checkPricing();
  await checkSchemaFeeds();
  await checkTrustManifests();
} catch (error) {
  failures.push(`[setup] ${error.message}`);
} finally {
  clearTimeout(watchdog);
  stop();
}

if (failures.length) {
  console.error(`check-agent-readiness-r2: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  "check-agent-readiness-r2: /pricing.md, robots.txt schemamap, Schema Map and JSONL feed, trust manifests OK",
);
