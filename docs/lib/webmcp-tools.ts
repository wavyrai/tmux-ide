import { APP_COMMAND, INSTALL_COMMAND, absoluteUrl } from "@/lib/site";
import { INSTALL_METHODS } from "@/lib/landing-content";

/** The fields of a WebMCP `ModelContextTool` this site registers. */
export interface DocsTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object" } & Record<string, unknown>;
  readonly annotations: { readonly readOnlyHint: true };
  readonly execute: (
    input: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
}

export interface DocsSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface InstallInstructions {
  readonly install: string;
  readonly run: string;
  readonly alternative: string;
  readonly installNotes: string;
  readonly alternativeRequires: string;
  readonly docs: string;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;
const DOCS_PATH = /^\/docs(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null ? Reflect.get(input, key) : undefined;
}

function parseQuery(input: unknown): { query: string; limit: number } {
  const query = field(input, "query");
  if (typeof query !== "string" || query.trim() === "")
    throw new TypeError("query must be a non-empty string");
  if (query.length > MAX_QUERY_LENGTH)
    throw new TypeError(`query must be at most ${MAX_QUERY_LENGTH} characters`);
  const limit = field(input, "limit") ?? DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return { query: query.trim(), limit };
}

function plainText(content: string): string {
  return content.replace(/<\/?mark>/gu, "");
}

function toSearchResults(body: unknown, limit: number): DocsSearchResult[] {
  if (!Array.isArray(body)) throw new Error("Unexpected search response");
  const results: DocsSearchResult[] = [];
  let pageTitle = "";
  for (const entry of body) {
    const url = field(entry, "url");
    const content = field(entry, "content");
    if (typeof url !== "string" || typeof content !== "string") continue;
    const text = plainText(content);
    if (field(entry, "type") === "page") pageTitle = text;
    results.push({ title: pageTitle || text, url: absoluteUrl(url), snippet: text });
    if (results.length === limit) break;
  }
  return results;
}

/** Maps "/docs/x", "docs/x", "/docs/x.md" or a tmux-ide.com URL to "/docs/x"; rejects the rest. */
export function docsPathFrom(input: unknown, origin: string): string {
  const path = field(input, "path");
  if (typeof path !== "string" || path.trim() === "")
    throw new TypeError("path must be a non-empty string");
  const trimmed = path.trim();
  const base = new URL(origin);
  const url = new URL(
    /^[a-z]+:/iu.test(trimmed) ? trimmed : `/${trimmed.replace(/^\/+/u, "")}`,
    base,
  );
  const ownHosts = new Set([base.host, new URL(absoluteUrl("/")).host]);
  if (!ownHosts.has(url.host)) throw new RangeError("path must be on tmux-ide.com");
  const pathname = url.pathname.replace(/\.mdx?$/u, "").replace(/\/+$/u, "");
  if (!DOCS_PATH.test(pathname)) throw new RangeError("path must be /docs or a page under /docs/");
  return pathname;
}

async function fetchOk(url: string, signal: AbortSignal | undefined): Promise<Response> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "text/markdown, application/json" },
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
  return response;
}

function installInstructions(): InstallInstructions {
  const curl = INSTALL_METHODS.find((method) => method.id === "curl");
  const npm = INSTALL_METHODS.find((method) => method.id === "npm");
  if (!curl || !npm) throw new Error("Install methods missing");
  return {
    install: INSTALL_COMMAND,
    run: APP_COMMAND,
    installNotes: curl.note,
    alternative: npm.command,
    alternativeRequires: npm.note,
    docs: absoluteUrl("/docs/getting-started"),
  };
}

/** The site's WebMCP tools, all read-only, backed by same-origin routes that already exist. */
export function createDocsTools(origin: string): readonly DocsTool[] {
  return [
    {
      name: "search_docs",
      title: "Search the tmux-ide docs",
      description:
        "Full-text search over the tmux-ide documentation. Returns matching pages and sections with their title, absolute URL and a text snippet.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Words to search for",
            minLength: 1,
            maxLength: MAX_QUERY_LENGTH,
          },
          limit: {
            type: "integer",
            description: `Maximum results (default ${DEFAULT_LIMIT})`,
            minimum: 1,
            maximum: MAX_LIMIT,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async execute(input, options) {
        const { query, limit } = parseQuery(input);
        const url = new URL("/api/search", origin);
        url.searchParams.set("query", query);
        const response = await fetchOk(url.toString(), options?.signal);
        return toSearchResults(await response.json(), limit);
      },
    },
    {
      name: "get_page_markdown",
      title: "Get a docs page as Markdown",
      description:
        "Returns the Markdown source of one tmux-ide documentation page. Accepts a path such as /docs/getting-started or a full https://tmux-ide.com/docs/... URL.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "A /docs path or a tmux-ide.com docs URL, for example /docs/getting-started",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async execute(input, options) {
        const pathname = docsPathFrom(input, origin);
        const response = await fetchOk(
          new URL(`${pathname}.md`, origin).toString(),
          options?.signal,
        );
        return response.text();
      },
    },
    {
      name: "get_install_command",
      title: "Get the tmux-ide install command",
      description:
        "Returns the command that installs tmux-ide, the command that opens the app, and the npm alternative with its requirement.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async execute() {
        return installInstructions();
      },
    },
  ];
}
