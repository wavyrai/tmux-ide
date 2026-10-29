// Serves the built site with `next start` and checks the agent discovery files
// (/.well-known/*), the homepage Link header, and the links to them from
// llms.txt, agents.md and the footer. Run after `next build`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(docsDir, "..");
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tmux-ide.com").replace(
  /\/+$/u,
  "",
);
const REPO = "https://github.com/wavyrai/tmux-ide";
const SKILL_RAW_URL = "https://raw.githubusercontent.com/wavyrai/tmux-ide/main/skill/SKILL.md";
const RFC9727_PROFILE = "https://www.rfc-editor.org/info/rfc9727";

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

const port = await freePort();
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
  console.error("check-agent-discovery: timed out after 120 s");
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

/** Same-site absolute URLs are requested from the local server. */
const local = (url) =>
  url.startsWith(`${siteUrl}/`) ? `${origin}${url.slice(siteUrl.length)}` : url;
const isSameSite = (url) => url === siteUrl || url.startsWith(`${siteUrl}/`);

async function get(path, method = "GET") {
  const response = await fetch(local(path.startsWith("/") ? `${siteUrl}${path}` : path), {
    method,
    redirect: "manual",
  });
  const body = method === "HEAD" ? "" : await response.text();
  return { status: response.status, headers: response.headers, body };
}

async function getJson(path, expectedType) {
  const response = await get(path);
  if (response.status !== 200) {
    fail("route-200", `${path} returned ${response.status}, expected 200`);
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!expectedType(contentType)) fail("content-type", `${path} has Content-Type "${contentType}"`);
  try {
    return JSON.parse(response.body);
  } catch (error) {
    fail("valid-json", `${path} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

/** Parses a media type into its lowercase essence and parameters (quotes removed). */
function mediaType(value) {
  const [essence, ...params] = value.split(";").map((part) => part.trim());
  const parameters = Object.fromEntries(
    params.filter(Boolean).map((param) => {
      const index = param.indexOf("=");
      return [
        param.slice(0, index).trim().toLowerCase(),
        param
          .slice(index + 1)
          .trim()
          .replace(/^"|"$/gu, ""),
      ];
    }),
  );
  return { essence: essence.toLowerCase(), parameters };
}
const isType = (essence) => (value) => mediaType(value).essence === essence;

/** RFC 8288 Link header: `<target>; rel="x"; ...` entries separated by commas. */
function parseLinkHeader(value) {
  return [...value.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/gu)].map((match) => {
    const params = Object.fromEntries(
      [...match[2].matchAll(/;\s*([a-z*-]+)\s*=\s*(?:"([^"]*)"|([^;,\s]+))/giu)].map((param) => [
        param[1].toLowerCase(),
        param[2] ?? param[3],
      ]),
    );
    return { target: match[1], rel: (params.rel ?? "").split(/\s+/u), params };
  });
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Tool names registered in the MCP server source, in order. */
function registeredTools() {
  const source = readFileSync(resolve(repoRoot, "packages/daemon/src/mcp.ts"), "utf8");
  return [...source.matchAll(/registerTool\(\s*"([^"]+)"/gu)].map((match) => match[1]);
}
function registeredServerVersion() {
  const source = readFileSync(resolve(repoRoot, "packages/daemon/src/mcp.ts"), "utf8");
  return source.match(/new McpServer\(\{[^}]*version:\s*"([^"]+)"/u)?.[1];
}
const skillDigest = `sha256:${createHash("sha256")
  .update(readFileSync(resolve(repoRoot, "skill/SKILL.md")))
  .digest("hex")}`;

const URN_AIR = /^urn:air:tmux-ide\.com(:[a-zA-Z0-9._-]+)+$/u;

function checkEntries(name, entries, { requireDisplayName }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("catalog-entries", `${name} has no entries array`);
    return [];
  }
  for (const entry of entries) {
    const label = `${name} entry ${entry.identifier ?? JSON.stringify(entry)}`;
    if (typeof entry.identifier !== "string" || !URN_AIR.test(entry.identifier))
      fail("catalog-entries", `${label}: identifier is not a urn:air id on tmux-ide.com`);
    if (requireDisplayName && typeof entry.displayName !== "string")
      fail("catalog-entries", `${label}: displayName is required`);
    if (typeof entry.type !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/u.test(entry.type))
      fail("catalog-entries", `${label}: type is not a media type`);
    if ("url" in entry === "data" in entry)
      fail("catalog-entries", `${label}: needs exactly one of url or data`);
  }
  return entries;
}

const REQUIRED_RESOURCES = [
  ["application/mcp-server-card+json", `${siteUrl}/.well-known/mcp/server-card.json`],
  ["application/agent-skills+md", SKILL_RAW_URL],
  ["text/markdown", `${siteUrl}/agents.md`],
  ["text/plain", `${siteUrl}/llms.txt`],
];

async function checkEntryTargets(name, entries) {
  for (const [type, url] of REQUIRED_RESOURCES) {
    if (!entries.some((entry) => entry.type === type && entry.url === url))
      fail("catalog-resources", `${name} does not list ${url} as ${type}`);
  }
  for (const entry of entries) {
    if (typeof entry.url !== "string" || !isSameSite(entry.url)) continue;
    const response = await get(entry.url);
    if (response.status !== 200)
      fail(
        "catalog-targets",
        `${name} entry ${entry.identifier} points at ${entry.url} (${response.status})`,
      );
    else if (mediaType(response.headers.get("content-type") ?? "").essence !== entry.type)
      fail(
        "catalog-targets",
        `${name} entry ${entry.identifier} declares ${entry.type}, served as ${response.headers.get("content-type")}`,
      );
  }
}

try {
  await waitForServer();
  const tools = registeredTools();
  if (tools.length === 0)
    throw new Error("found no registerTool calls in packages/daemon/src/mcp.ts");

  // ard.json: every entry valid, the four real resources listed.
  const ard = await getJson("/.well-known/ard.json", isType("application/json"));
  if (ard) {
    const entries = checkEntries("ard.json", ard.entries, { requireDisplayName: true });
    await checkEntryTargets("ard.json", entries);
    const mcp = entries.find((entry) => entry.type === "application/mcp-server-card+json");
    if (mcp?.capabilities && !sameSet(mcp.capabilities, tools))
      fail(
        "server-card-tools",
        `ard.json MCP capabilities ${mcp.capabilities} differ from mcp.ts tools ${tools}`,
      );
  }

  // ai-catalog.json: AI Catalog 1.0 with the same identifiers as ard.json.
  const catalog = await getJson(
    "/.well-known/ai-catalog.json",
    isType("application/ai-catalog+json"),
  );
  if (catalog) {
    if (catalog.specVersion !== "1.0")
      fail("ai-catalog", `specVersion is ${catalog.specVersion}, expected "1.0"`);
    const entries = checkEntries("ai-catalog.json", catalog.entries, { requireDisplayName: false });
    await checkEntryTargets("ai-catalog.json", entries);
    if (
      ard?.entries &&
      !sameSet(
        entries.map((e) => e.identifier),
        ard.entries.map((e) => e.identifier),
      )
    )
      fail("ai-catalog", "ai-catalog.json and ard.json list different identifiers");
    const skill = entries.find((entry) => entry.url === SKILL_RAW_URL);
    if (skill && skill.digest !== skillDigest)
      fail(
        "skill-digest",
        `ai-catalog.json skill digest ${skill.digest} != ${skillDigest} (skill/SKILL.md)`,
      );
  }

  // The MCP server card: v1 schema shape, stdio launch, tools equal mcp.ts.
  const card = await getJson(
    "/.well-known/mcp/server-card.json",
    isType("application/mcp-server-card+json"),
  );
  if (card) {
    if (
      card.$schema !== "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"
    )
      fail("server-card", `$schema is ${card.$schema}`);
    if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/u.test(card.name ?? ""))
      fail("server-card", `name ${card.name} is not reverse-DNS with one slash`);
    if (
      typeof card.description !== "string" ||
      card.description.length < 1 ||
      card.description.length > 100
    )
      fail("server-card", "description must be 1-100 characters");
    if (card.version !== registeredServerVersion())
      fail(
        "server-card",
        `version ${card.version} != mcp.ts McpServer version ${registeredServerVersion()}`,
      );
    if ("tools" in card)
      fail("server-card", "the v1 card has no tools member (tools live under _meta)");
    const stdio = card._meta?.["com.tmux-ide/stdio"];
    if (stdio?.command !== "tmux-ide" || JSON.stringify(stdio?.args) !== '["mcp"]')
      fail("server-card", `stdio launch is ${JSON.stringify(stdio)}, expected tmux-ide mcp`);
    const cardTools = card._meta?.["com.tmux-ide/tools"];
    if (!Array.isArray(cardTools) || !sameSet(cardTools, tools))
      fail(
        "server-card-tools",
        `card tools ${JSON.stringify(cardTools)} != mcp.ts registerTool names ${JSON.stringify(tools)}`,
      );
    for (const icon of card.icons ?? []) {
      const response = await get(icon.src);
      if (response.status !== 200)
        fail("server-card", `icon ${icon.src} returned ${response.status}`);
    }
  }

  // RFC 9727 api-catalog: linkset+json with the profile, items, and a HEAD Link header.
  const apiCatalog = await getJson("/.well-known/api-catalog", (value) => {
    const { essence, parameters } = mediaType(value);
    return essence === "application/linkset+json" && parameters.profile === RFC9727_PROFILE;
  });
  if (apiCatalog) {
    const linkset = apiCatalog.linkset;
    if (!Array.isArray(linkset) || linkset.length === 0) fail("api-catalog", "no linkset array");
    else {
      if (!linkset.some((context) => Array.isArray(context.item) && context.item.length > 0))
        fail("api-catalog", "no item links");
      for (const context of linkset) {
        if (typeof context.anchor !== "string") fail("api-catalog", "a link context has no anchor");
        for (const [relation, targets] of Object.entries(context)) {
          if (relation === "anchor") continue;
          for (const target of targets) {
            if (!isSameSite(target.href)) continue;
            const response = await get(target.href);
            if (response.status !== 200)
              fail("api-catalog", `${relation} ${target.href} returned ${response.status}`);
          }
        }
      }
    }
  }
  const head = await get("/.well-known/api-catalog", "HEAD");
  const headLinks = parseLinkHeader(head.headers.get("link") ?? "");
  if (head.status !== 200 || !headLinks.some((link) => link.rel.includes("api-catalog")))
    fail("api-catalog", `HEAD returned ${head.status} without a rel="api-catalog" Link header`);

  // Agent skills index v0.2.0: the digest is the committed skill/SKILL.md's.
  const skills = await getJson("/.well-known/agent-skills/index.json", isType("application/json"));
  if (skills) {
    if (skills.$schema !== "https://schemas.agentskills.io/discovery/0.2.0/schema.json")
      fail("skills-index", `$schema is ${skills.$schema}`);
    const entry = skills.skills?.find((skill) => skill.url === SKILL_RAW_URL);
    if (!entry || entry.type !== "skill-md" || !entry.name || !entry.description)
      fail("skills-index", `no skill-md entry with name and description for ${SKILL_RAW_URL}`);
    else if (entry.digest !== skillDigest)
      fail("skill-digest", `index digest ${entry.digest} != ${skillDigest} (skill/SKILL.md)`);
  }

  // Homepage Link header: each discovery target, each one a built route.
  const home = await get("/");
  const links = parseLinkHeader(home.headers.get("link") ?? "");
  for (const [path, rel] of [
    ["/llms.txt", "describedby"],
    ["/agents.md", "describedby"],
    ["/.well-known/ard.json", "ard"],
    ["/.well-known/api-catalog", "api-catalog"],
    ["/sitemap.xml", "sitemap"],
  ]) {
    const link = links.find((candidate) => candidate.target === `${siteUrl}${path}`);
    if (!link) fail("homepage-link-header", `no Link to ${siteUrl}${path}`);
    else if (!link.rel.includes(rel))
      fail("homepage-link-header", `${path} has rel ${link.rel}, expected ${rel}`);
  }
  for (const link of links) {
    if (!isSameSite(link.target)) continue;
    const response = await get(link.target);
    if (response.status !== 200)
      fail("homepage-link-header", `Link target ${link.target} returned ${response.status}`);
  }

  // llms.txt and agents.md link the discovery files, the skill and AGENTS.md.
  const agentsMdUrl = `${REPO}/blob/main/AGENTS.md`;
  const required = [
    "/.well-known/ard.json",
    "/.well-known/ai-catalog.json",
    "/.well-known/mcp/server-card.json",
    "/.well-known/api-catalog",
    "/.well-known/agent-skills/index.json",
  ].map((path) => `${siteUrl}${path}`);
  required.push(`${REPO}/tree/main/skill`, agentsMdUrl);
  for (const path of ["/llms.txt", "/agents.md"]) {
    const { body } = await get(path);
    for (const url of required)
      if (!body.includes(url)) fail("llms-agents-links", `${path} does not link ${url}`);
  }

  // AGENTS.md is linked from the homepage and the docs (the shared footer).
  for (const path of ["/", "/docs"]) {
    const { body } = await get(path);
    if (!body.includes(`href="${agentsMdUrl}"`))
      fail("agents-md-link", `${path} does not link ${agentsMdUrl}`);
  }

  // The Agent Plugins manifest at the repo root (the plugin root).
  try {
    const plugin = JSON.parse(readFileSync(resolve(repoRoot, "plugin.json"), "utf8"));
    if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
      fail("plugin-manifest", `plugin.json $schema is ${plugin.$schema}`);
    if (!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(plugin.name ?? ""))
      fail("plugin-manifest", `plugin.json name ${plugin.name} is invalid`);
  } catch (error) {
    fail("plugin-manifest", `no readable plugin.json at the repo root: ${error.message}`);
  }
} catch (error) {
  failures.push(`[setup] ${error.message}`);
} finally {
  clearTimeout(watchdog);
  stop();
}

if (failures.length) {
  console.error(`check-agent-discovery: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("check-agent-discovery: discovery files, Link header and links OK");
