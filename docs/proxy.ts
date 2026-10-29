import { type NextRequest, NextResponse } from "next/server";
import { MARKDOWN_VARY, notFoundMarkdown } from "@/lib/agent-markdown";
import { absoluteUrl } from "@/lib/site";

/**
 * Markdown for agents on the HTML routes: `/` and the docs pages answer with
 * their markdown twin when the request asks for markdown. The matcher leaves
 * only extensionless page paths. `/` and `/docs/**` have markdown twins, the
 * pages in HTML_ONLY_PAGES answer with HTML, and any other path asked for as
 * markdown gets a markdown 404 here (check-agent-markdown.mjs fails if a new
 * page route is in neither list).
 */

// User-initiated fetchers only. Search crawlers (Googlebot, Bingbot, GPTBot,
// ClaudeBot) keep the HTML so indexing is unchanged.
const AGENT_FETCHERS = /\b(?:Claude-User|ChatGPT-User|Perplexity-User)\//u;

interface MediaRange {
  readonly type: string;
  readonly q: number;
  readonly index: number;
}

function parseAccept(accept: string): MediaRange[] {
  return accept.split(",").flatMap((part, index) => {
    const [type = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    if (!type) return [];
    const qParam = params.find((param) => param.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    return [{ type, q: Number.isFinite(q) ? q : 0, index }];
  });
}

/** The most specific range that covers `type` (RFC 9110 §12.5.1), if any. */
function rangeFor(ranges: MediaRange[], type: string): MediaRange | undefined {
  const [major] = type.split("/");
  return (
    ranges.find((range) => range.type === type) ??
    ranges.find((range) => range.type === `${major}/*`) ??
    ranges.find((range) => range.type === "*/*")
  );
}

/**
 * True when the Accept header ranks text/markdown above text/html. At equal
 * quality markdown wins only when the client names text/markdown itself and
 * before any explicit text/html; browsers never name it, so `*\/*` alone and
 * browser Accept strings get HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = parseAccept(accept);
  const markdown = rangeFor(ranges, "text/markdown");
  if (!markdown || markdown.q <= 0 || markdown.type !== "text/markdown") return false;
  const html = rangeFor(ranges, "text/html");
  if (!html || markdown.q > html.q) return true;
  return markdown.q === html.q && (html.type !== "text/html" || markdown.index < html.index);
}

function wantsMarkdown(request: NextRequest): boolean {
  return (
    prefersMarkdown(request.headers.get("accept")) ||
    AGENT_FETCHERS.test(request.headers.get("user-agent") ?? "")
  );
}

// HTML pages with no markdown twin: a markdown request gets the HTML page.
const HTML_ONLY_PAGES = new Set(["/tmux-for-coding-agents"]);

/** The markdown route behind an HTML page path, or null for a path this site has no page for. */
function markdownRoute(pathname: string): string | null {
  if (pathname === "/") return "/index.md";
  if (pathname === "/docs" || pathname.startsWith("/docs/"))
    return `/llms.mdx${pathname.replace(/\/+$/u, "")}`;
  return null;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, searchParams } = request.nextUrl;
  if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next();
  // Client-side navigation and prefetches fetch RSC payloads; leave them alone.
  if (request.headers.has("rsc") || searchParams.has("_rsc")) return NextResponse.next();

  const agentMode = pathname === "/" && searchParams.get("mode") === "agent";
  // Vary on the pages themselves comes from next.config.mjs and the markdown routes:
  // Next replaces a proxy's Vary on a rendered page or route handler.
  if (!agentMode && !wantsMarkdown(request)) return NextResponse.next();

  if (HTML_ONLY_PAGES.has(pathname.replace(/\/+$/u, ""))) return NextResponse.next();
  const route = markdownRoute(pathname);
  if (!route) {
    return new NextResponse(notFoundMarkdown(pathname), {
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: MARKDOWN_VARY },
    });
  }
  const response = NextResponse.rewrite(new URL(route, request.url));
  response.headers.set("Link", `<${absoluteUrl(pathname)}>; rel="canonical"`);
  return response;
}

export const config = {
  matcher: [
    {
      // Extensionless page paths only: no Next internals, API, well-known
      // files, OG images, the markdown twins or any file with an extension.
      source: "/((?!_next/|api/|\\.well-known/|og/|llms\\.mdx/)(?!.*\\.[^/]+$).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
