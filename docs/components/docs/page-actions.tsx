import {
  ChatGptMark,
  ClaudeMark,
  ExternalArrow,
  GitHubMark,
  MarkdownMark,
  PerplexityMark,
} from "@/components/docs/assistant-marks";
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

type PageActionProps = {
  /** Absolute canonical URL of the page. */
  pageUrl: string;
  /** Site-relative URL of the page's Markdown twin. */
  markdownUrl: string;
  /** GitHub URL of the page's MDX source. */
  sourceUrl: string;
};

const newTab = <span className="sr-only"> (opens in a new tab)</span>;

/**
 * Page actions in the table-of-contents rail, below "On this page": a
 * "Page" group (copy, Markdown, source) and an "Explore with AI" group.
 * Everything but Copy page is a plain link, so it works without JavaScript.
 */
export function RailActions({ pageUrl, markdownUrl, sourceUrl }: PageActionProps) {
  return (
    <div className="docs-rail-actions">
      <section aria-labelledby="rail-page-actions">
        <p id="rail-page-actions" className="docs-rail-label">
          Page
        </p>
        <ul>
          <li>
            <CopyPageButton markdownUrl={markdownUrl} className="docs-rail-link" />
          </li>
          <li>
            <a href={markdownUrl} className="docs-rail-link">
              <MarkdownMark />
              View as Markdown
            </a>
          </li>
          <li>
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="docs-rail-link"
            >
              <GitHubMark />
              Edit on GitHub
              <ExternalArrow className="docs-rail-arrow" />
              {newTab}
            </a>
          </li>
        </ul>
      </section>
      <section aria-labelledby="rail-explore-ai">
        <p id="rail-explore-ai" className="docs-rail-label">
          Explore with AI
        </p>
        <ul>
          {exploreLinks(pageUrl).map(({ name, href, Mark }) => (
            <li key={name}>
              <a href={href} target="_blank" rel="noopener noreferrer" className="docs-rail-link">
                <Mark />
                Open in {name}
                <ExternalArrow className="docs-rail-arrow" />
                {newTab}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The compact row above the title, for layouts without the rail (narrow
 * screens, full-width pages). The page template shows it only then.
 */
export function PageActions({
  pageUrl,
  markdownUrl,
  sourceUrl,
  className = "",
}: PageActionProps & { className?: string }) {
  return (
    <div
      className={`docs-page-actions not-prose mb-8 flex flex-wrap items-center gap-x-2 gap-y-3 ${className}`}
    >
      <CopyPageButton markdownUrl={markdownUrl} />
      <a href={markdownUrl} className="docs-action">
        <MarkdownMark />
        View as Markdown
      </a>
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="docs-action">
        <GitHubMark />
        Edit on GitHub
        {newTab}
      </a>
      <div
        role="group"
        aria-labelledby="row-explore-ai"
        className="flex flex-wrap items-center gap-x-2 gap-y-3"
      >
        <span id="row-explore-ai" className="type-caption-1 pr-1 text-fd-muted-foreground">
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
            {newTab}
          </a>
        ))}
      </div>
    </div>
  );
}
