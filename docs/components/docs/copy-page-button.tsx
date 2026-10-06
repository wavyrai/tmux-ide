"use client";

import { CopyGlyph, useCopy } from "@/components/copy-status";

/** Copies the current page as Markdown, fetched from its .mdx twin route. */
export function CopyPageButton({
  markdownUrl,
  className = "docs-action",
}: {
  markdownUrl: string;
  className?: string;
}) {
  const { status, copy } = useCopy();

  const onClick = () => {
    const markdown = fetch(markdownUrl).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });
    void copy(markdown);
  };

  return (
    <>
      <button type="button" onClick={onClick} className={className}>
        <CopyGlyph status={status} />
        Copy page
      </button>
      <span
        role="status"
        aria-live="polite"
        className={status === "failed" ? "type-caption-1 text-fd-muted-foreground" : "sr-only"}
      >
        {status === "copied"
          ? "Page copied as Markdown."
          : status === "failed"
            ? "Could not copy. Use View as Markdown instead."
            : ""}
      </span>
    </>
  );
}
