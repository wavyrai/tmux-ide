import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Markdown for agents, checked against the built site served by `next start`:
// Accept negotiation, ?mode=agent, agent fetcher User-Agents, frontmatter on the
// markdown pages, the docs llms.txt, agents.md's when-to-use section and the
// markdown 404. Browsers and search crawlers must keep getting HTML.

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const builtHome = readFileSync(resolve(appDir, "index.html"), "utf8");
// The homepage's HTML canonical, byte for byte: its markdown twin must name the same URL.
const homeCanonical = builtHome.match(/<link rel="canonical" href="([^"]+)"/u)?.[1] ?? "invalid:";
const origin = new URL(homeCanonical).origin;
const gitDates = JSON.parse(readFileSync(resolve(docsDir, ".source/git-dates.json"), "utf8"));

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const AGENT_UAS = {
  "Claude-User":
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  "ChatGPT-User":
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  "Perplexity-User":
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
};
const CRAWLER_UAS = {
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  GPTBot:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
  ClaudeBot:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
};

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

async function startServer(port) {
  const nextBin = resolve(docsDir, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: docsDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${log}`);
    try {
      await fetch(`http://127.0.0.1:${port}/llms.txt`);
      return child;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  child.kill("SIGKILL");
  throw new Error(`next start did not answer within 30 s:\n${log}`);
}

/** GET with no Accept header: fetch always adds one, node:http doesn't. */
function withoutAccept(url) {
  return new Promise((done, reject) => {
    const req = httpRequest(url, { headers: { "user-agent": BROWSER_UA } }, (res) => {
      res.resume();
      res.on("end", () => done({ contentType: res.headers["content-type"] ?? "" }));
    });
    req.on("error", reject);
    req.end();
  });
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const failures = [];
const fail = (message) => failures.push(message);

/** Parses a leading `---` frontmatter block into key/value strings, or null. */
function frontmatter(body) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(body);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z_]+):\s*(.*)$/u.exec(line);
    if (!pair) continue;
    const raw = pair[2].trim();
    fields[pair[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return { fields, rest: body.slice(match[0].length) };
}

const varies = (response, name) =>
  (response.headers.get("vary") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(name);
const isMarkdown = (response) =>
  (response.headers.get("content-type") ?? "").startsWith("text/markdown");
const isHtml = (response) => (response.headers.get("content-type") ?? "").startsWith("text/html");

async function run(base) {
  const get = (path, headers = {}) =>
    fetch(`${base}${path}`, {
      headers: { "user-agent": BROWSER_UA, ...headers },
      redirect: "manual",
    });

  for (const path of ["/", "/docs/getting-started", "/docs"]) {
    const md = await get(path, { accept: "text/markdown" });
    const mdBody = await md.text();
    if (md.status !== 200 || !isMarkdown(md))
      fail(
        `${path} with Accept: text/markdown must return 200 text/markdown, got ${md.status} ${md.headers.get("content-type")}`,
      );
    if (!varies(md, "accept"))
      fail(`${path} markdown response must send Vary: Accept, got "${md.headers.get("vary")}"`);
    if (!varies(md, "user-agent"))
      fail(`${path} markdown response must send Vary: User-Agent, got "${md.headers.get("vary")}"`);
    if (!mdBody.startsWith("---\n"))
      fail(
        `${path} markdown response must open with --- frontmatter, got ${JSON.stringify(mdBody.slice(0, 40))}`,
      );
    const canonical = `<${path === "/" ? homeCanonical : `${origin}${path}`}>; rel="canonical"`;
    if (!(md.headers.get("link") ?? "").includes(canonical))
      fail(
        `${path} markdown response must send Link: ${canonical}, got "${md.headers.get("link")}"`,
      );

    const html = await get(path, { accept: BROWSER_ACCEPT });
    await html.arrayBuffer();
    if (html.status !== 200 || !isHtml(html))
      fail(
        `${path} with a browser Accept must return 200 text/html, got ${html.status} ${html.headers.get("content-type")}`,
      );
    if (!varies(html, "rsc"))
      fail(`${path} HTML response must keep Next's Vary: rsc, got "${html.headers.get("vary")}"`);
  }

  // `next start` sets the Vary of a rendered page itself and drops the configured
  // one (next/dist/build/templates/app-page-runtime.js, res.setHeader('Vary', ...)),
  // so the HTML side is checked in the header rules the build hands to the host.
  const routesManifest = JSON.parse(
    readFileSync(resolve(docsDir, ".next/routes-manifest.json"), "utf8"),
  );
  for (const source of ["/", "/docs/:path*"]) {
    const vary = routesManifest.headers
      .filter((rule) => rule.source === source)
      .flatMap((rule) => rule.headers)
      .find((header) => header.key.toLowerCase() === "vary")?.value;
    const names = (vary ?? "").split(",").map((name) => name.trim().toLowerCase());
    for (const name of ["accept", "user-agent", "rsc", "next-router-state-tree"]) {
      if (!names.includes(name))
        fail(`next.config.mjs must send Vary with ${name} on ${source}, got "${vary}"`);
    }
  }

  // On Vercel too the prerendered page's Vary wins over next.config.mjs (measured
  // live on #637), so vercel.json appends Accept to the response's Vary at the edge.
  // Not visible to `next start`: checked live after deploy (card #647 item 3).
  const vercel = JSON.parse(read(resolve(docsDir, "vercel.json")) || "{}");
  for (const path of ["/", "/docs", "/docs/getting-started"]) {
    const appends = (vercel.routes ?? []).some(
      (route) =>
        route.continue === true &&
        new RegExp(route.src, "u").test(path) &&
        (route.transforms ?? []).some(
          (transform) =>
            transform.type === "response.headers" &&
            transform.op === "append" &&
            transform.target?.key?.toLowerCase?.() === "vary" &&
            String(transform.args)
              .split(",")
              .map((name) => name.trim().toLowerCase())
              .includes("accept"),
        ),
    );
    if (!appends)
      fail(
        `vercel.json must append Accept to Vary on ${path} (a continue route with a response.headers transform)`,
      );
  }
  for (const path of ["/about", "/llms.txt", "/_next/static/chunk.js"]) {
    if ((vercel.routes ?? []).some((route) => new RegExp(route.src, "u").test(path)))
      fail(`vercel.json routes must leave ${path} alone; it is not a negotiated page`);
  }

  for (const accept of [
    "*/*",
    BROWSER_ACCEPT,
    "text/html, text/markdown",
    "text/markdown;q=0.5, text/html",
    "text/markdown;q=0, */*",
    // #637 review N2: a refused markdown range, and HTML reached through a wildcard.
    "text/markdown;q=0",
    "text/markdown;q=0.5, text/*",
    "text/markdown;q=0.5, */*",
  ]) {
    const response = await get("/", { accept });
    await response.arrayBuffer();
    if (!isHtml(response))
      fail(
        `/ with Accept: ${accept} must return HTML, got ${response.headers.get("content-type")}`,
      );
  }
  for (const accept of [
    "text/markdown, text/html;q=0.9, */*;q=0.8",
    "text/markdown, text/html",
    "text/plain;q=0.5, text/markdown",
    // Media types are case-insensitive (RFC 9110 §8.3.1).
    "TEXT/MARKDOWN",
  ]) {
    const response = await get("/", { accept });
    await response.arrayBuffer();
    if (!isMarkdown(response))
      fail(
        `/ with Accept: ${accept} must return markdown, got ${response.headers.get("content-type")}`,
      );
  }

  // A request with no Accept header at all (fetch would add `*/*`) gets HTML.
  const bare = await withoutAccept(`${base}/`);
  if (!bare.contentType.startsWith("text/html"))
    fail(`/ with no Accept header must return HTML, got ${bare.contentType}`);

  // Next answers an RSC request without its _rsc cache key with a redirect to it.
  const rsc = await fetch(`${base}/`, { headers: { accept: "*/*", rsc: "1" } });
  await rsc.arrayBuffer();
  if (
    !(rsc.headers.get("content-type") ?? "").startsWith("text/x-component") ||
    !varies(rsc, "rsc")
  )
    fail(
      `/ RSC request must keep its RSC payload and Vary: rsc, got ${rsc.headers.get("content-type")} "${rsc.headers.get("vary")}"`,
    );

  const home = await get("/", { accept: BROWSER_ACCEPT });
  await home.arrayBuffer();
  if (
    !(home.headers.get("link") ?? "").includes('</index.md>; rel="alternate"; type="text/markdown"')
  )
    fail(
      `/ must send Link: </index.md>; rel="alternate"; type="text/markdown", got "${home.headers.get("link")}"`,
    );

  const agentMode = await get("/?mode=agent", { accept: BROWSER_ACCEPT });
  const agentModeBody = await agentMode.text();
  if (!isMarkdown(agentMode) || !agentModeBody.startsWith("---\n"))
    fail(
      `/?mode=agent must return the markdown homepage, got ${agentMode.headers.get("content-type")}`,
    );

  for (const [name, ua] of Object.entries(AGENT_UAS)) {
    for (const path of ["/", "/docs/getting-started"]) {
      const response = await get(path, { accept: BROWSER_ACCEPT, "user-agent": ua });
      await response.arrayBuffer();
      if (!isMarkdown(response))
        fail(
          `${name} User-Agent on ${path} must get markdown, got ${response.headers.get("content-type")}`,
        );
    }
  }
  for (const [name, ua] of Object.entries(CRAWLER_UAS)) {
    for (const path of ["/", "/docs/getting-started"]) {
      const response = await get(path, { accept: BROWSER_ACCEPT, "user-agent": ua });
      await response.arrayBuffer();
      if (!isHtml(response))
        fail(
          `${name} User-Agent on ${path} must get HTML, got ${response.headers.get("content-type")}`,
        );
    }
  }

  const pages = [
    { path: "/index.md", canonical: homeCanonical, date: gitDates.home },
    {
      path: "/docs/getting-started.md",
      canonical: `${origin}/docs/getting-started`,
      date: gitDates.pages["getting-started.mdx"],
    },
    { path: "/docs.md", canonical: `${origin}/docs`, date: gitDates.pages["index.mdx"] },
    {
      path: "/docs/commands.mdx",
      canonical: `${origin}/docs/commands`,
      date: gitDates.pages["commands.mdx"],
    },
  ];
  for (const { path, canonical, date } of pages) {
    const response = await get(path);
    const body = await response.text();
    if (response.status !== 200 || !isMarkdown(response)) {
      fail(
        `${path} must return 200 text/markdown, got ${response.status} ${response.headers.get("content-type")}`,
      );
      continue;
    }
    const parsed = frontmatter(body);
    if (!parsed) {
      fail(
        `${path} must open with a --- frontmatter block, got ${JSON.stringify(body.slice(0, 40))}`,
      );
      continue;
    }
    const { fields, rest } = parsed;
    if (!fields.title) fail(`${path} frontmatter must have a title`);
    if (!fields.description) fail(`${path} frontmatter must have a description`);
    if (fields.canonical !== canonical)
      fail(`${path} frontmatter canonical must be ${canonical}, got ${fields.canonical}`);
    // Dates exist only when the build host has full git history (see generate-git-dates.mjs).
    if (date && fields.last_updated !== date)
      fail(`${path} frontmatter last_updated must be ${date}, got ${fields.last_updated}`);
    if (!date && "last_updated" in fields)
      fail(`${path} frontmatter must leave out last_updated when git history cannot back it`);
    if (!/^\n?# \S/u.test(rest))
      fail(`${path} must start its body with a # heading after the frontmatter`);
  }

  const indexLink = (await get("/index.md")).headers.get("link") ?? "";
  if (!indexLink.split(", ").includes(`<${homeCanonical}>; rel="canonical"`))
    fail(`/index.md must send Link: <${homeCanonical}>; rel="canonical", got "${indexLink}"`);

  // The markdown and text routes themselves stay outside the proxy.
  for (const path of ["/index.md", "/docs/getting-started.md", "/llms.txt", "/agents.md"]) {
    const response = await get(path, { accept: "text/markdown" });
    await response.arrayBuffer();
    if (response.status !== 200)
      fail(`${path} with Accept: text/markdown must return 200, got ${response.status}`);
  }

  const docsIndex = await get("/docs/llms.txt");
  const docsIndexBody = await docsIndex.text();
  if (docsIndex.status !== 200) fail(`/docs/llms.txt must exist, got ${docsIndex.status}`);
  else {
    if (!/^# \S.*\n\n> \S/u.test(docsIndexBody))
      fail("/docs/llms.txt must start with a # heading and a > summary");
    if (/\]\(\//u.test(docsIndexBody)) fail("/docs/llms.txt links must be absolute URLs");
    if (!docsIndexBody.includes(`](${origin}/docs/getting-started)`))
      fail("/docs/llms.txt must link the docs pages");
  }
  const rootIndex = await (await get("/llms.txt")).text();
  for (const target of ["/docs/llms.txt", "/index.md"]) {
    if (!rootIndex.includes(`](${origin}${target})`)) fail(`llms.txt must link ${origin}${target}`);
  }
  if (!/^## When to use tmux-ide$/mu.test(rootIndex))
    fail("llms.txt must have a '## When to use tmux-ide' section");

  const manual = await (await get("/agents.md")).text();
  if (!/^## When to use tmux-ide$/mu.test(manual))
    fail("agents.md must have a '## When to use tmux-ide' section");
  if (!/^## When not to use tmux-ide$/mu.test(manual))
    fail("agents.md must say when not to use tmux-ide");

  // The markdown 404 is one fixed body: it never repeats the requested path, so
  // a crafted URL (#637 review N3) can't put its own text or headings in it.
  const probe = "__agent-markdown-404-probe";
  const injected = "%60%0A%23%20Injected";
  const notFoundBodies = new Set();
  for (const path of [
    `/${probe}`,
    `/docs/${probe}`,
    `/docs/${probe}${injected}`,
    `/docs/${probe}.md`,
  ]) {
    const md = await get(path, { accept: "text/markdown" });
    const body = await md.text();
    if (md.status !== 404 || !isMarkdown(md))
      fail(
        `${path} with Accept: text/markdown must return 404 text/markdown, got ${md.status} ${md.headers.get("content-type")}`,
      );
    else {
      notFoundBodies.add(body);
      if (!body.includes(`](${origin}/docs)`) || !body.includes(`](${origin}/llms.txt)`))
        fail(`${path} markdown 404 must link ${origin}/docs and ${origin}/llms.txt`);
      if (body.includes(probe) || /Injected/u.test(body))
        fail(`${path} markdown 404 must not echo the requested path, got ${JSON.stringify(body)}`);
    }
    if (path.endsWith(".md")) continue;
    const html = await get(path, { accept: BROWSER_ACCEPT });
    await html.arrayBuffer();
    if (html.status !== 404 || !isHtml(html))
      fail(
        `${path} with a browser Accept must return the HTML 404, got ${html.status} ${html.headers.get("content-type")}`,
      );
  }

  if (notFoundBodies.size > 1)
    fail(`the markdown 404 must be one fixed body, got ${notFoundBodies.size} different bodies`);

  // Every extensionless page route must still be found when asked for as
  // markdown: the proxy must not answer a real page with its markdown 404.
  const appRoutes = JSON.parse(
    readFileSync(resolve(docsDir, ".next/app-path-routes-manifest.json"), "utf8"),
  );
  for (const route of new Set(Object.values(appRoutes))) {
    if (/[[.]/u.test(route) || route.startsWith("/_")) continue;
    const response = await get(route, { accept: "text/markdown" });
    await response.arrayBuffer();
    if (response.status === 404)
      fail(`${route} is a built route but 404s with Accept: text/markdown`);
  }
}

if (!existsSync(resolve(appDir, "index.html"))) throw new Error("Run `next build` first");
const port = await freePort();
const server = await startServer(port);
try {
  await run(`http://127.0.0.1:${port}`);
} finally {
  server.kill("SIGTERM");
}

if (failures.length > 0) {
  console.error(`Agent markdown check failed (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  "Agent markdown: Accept negotiation with Vary on / and /docs, ?mode=agent, agent fetcher " +
    "User-Agents, crawler HTML, frontmatter on /index.md and the docs twins, /docs/llms.txt, " +
    "agents.md when-to-use, and the markdown 404.",
);
