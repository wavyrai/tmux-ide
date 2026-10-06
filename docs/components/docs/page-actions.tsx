import { ChatGptMark, ClaudeMark, PerplexityMark } from "@/components/docs/assistant-marks";
import { CopyPageButton } from "@/components/docs/copy-page-button";

/** The prompt each assistant receives; `pageUrl` is absolute. */
export function explorePrompt(pageUrl: string): string {
  const url = new URL(pageUrl);
  url.searchParams.set("ref", "explore-ai");
  return `Read ${url.toString()}, summarize the key points, and be ready to answer follow-up questions.`;
}

export function exploreLinks(pageUrl: string) {
  const q = encodeURIComponent(explorePrompt(pageUrl));
  return [
    { name: "ChatGPT", href: `https://chatgpt.com/?hints=search&q=${q}`, Mark: ChatGptMark },
    { name: "Claude", href: `https://claude.ai/new?q=${q}`, Mark: ClaudeMark },
    { name: "Perplexity", href: `https://www.perplexity.ai/search?q=${q}`, Mark: PerplexityMark },
  ] as const;
}

/**
 * The row above every docs title: copy the page as Markdown, open the raw
 * Markdown, edit the source, or hand the page to an assistant. Everything but
 * the copy button is a plain link, so the row works without JavaScript.
 */
export function PageActions({
  pageUrl,
  markdownUrl,
  sourceUrl,
}: {
  /** Absolute canonical URL of the page. */
  pageUrl: string;
  /** Site-relative URL of the page's Markdown twin. */
  markdownUrl: string;
  /** GitHub URL of the page's MDX source. */
  sourceUrl: string;
}) {
  return (
    <div className="docs-page-actions not-prose mb-8 flex flex-wrap items-center gap-x-2 gap-y-3">
      <CopyPageButton markdownUrl={markdownUrl} />
      <a href={markdownUrl} className="docs-action">
        View as Markdown
      </a>
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="docs-action">
        Edit on GitHub
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <div
        role="group"
        aria-labelledby="explore-ai-label"
        className="flex flex-wrap items-center gap-x-2 gap-y-3 lg:ml-auto"
      >
        <span id="explore-ai-label" className="type-caption-1 pr-1 text-fd-muted-foreground">
          Explore with AI
        </span>
        {exploreLinks(pageUrl).map(({ name, href, Mark }) => (
          <a
            key={name}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="docs-action"
          >
            <Mark />
            {/* Phones show the marks only; the name stays the accessible label. */}
            <span className="max-sm:sr-only">{name}</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ))}
      </div>
    </div>
  );
}
