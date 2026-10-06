/**
 * Marks for the docs page actions, drawn for this site on a 16-unit grid and
 * rendered at one optical size. All are decorative (aria-hidden): the link or
 * button text carries the name. Brand-tinted marks take their colour from
 * tokens in global.css; the rest follow the text colour.
 */
type MarkProps = { className?: string };

const frame = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  "aria-hidden": true,
} as const;

const line = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Six open links turning around a hexagonal centre. */
export function ChatGptMark({ className = "" }: MarkProps) {
  return (
    <svg {...frame} className={`mark-chatgpt ${className}`}>
      <g {...line} strokeWidth={1.3}>
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <path
            key={angle}
            d="M5.6 8.6V4.1a2.4 2.4 0 0 1 4.8 0v2.3"
            transform={`rotate(${angle} 8 8)`}
          />
        ))}
      </g>
    </svg>
  );
}

/** A coral burst of tapered rays. */
export function ClaudeMark({ className = "" }: MarkProps) {
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <svg {...frame} className={`mark-claude ${className}`}>
      <g {...line} strokeWidth={1.6}>
        {rays.map((angle, index) => (
          <path
            key={angle}
            d={`M8 ${index % 3 === 0 ? 1 : index % 3 === 1 ? 2.1 : 1.6}V6.4`}
            transform={`rotate(${angle} 8 8)`}
          />
        ))}
      </g>
    </svg>
  );
}

/** A folded, book-like spine in teal. */
export function PerplexityMark({ className = "" }: MarkProps) {
  return (
    <svg {...frame} className={`mark-perplexity ${className}`}>
      <g {...line} strokeWidth={1.15}>
        <path d="M8 1v14" />
        <path d="M2.75 5h10.5v5.75L8 8.25l-5.25 2.5z" />
        <path d="M2.75 5 8 1.5 13.25 5" />
        <path d="M5 9.6v4.4L8 11.5l3 2.5V9.6" />
      </g>
    </svg>
  );
}

/** The GitHub mark. */
export function GitHubMark({ className = "" }: MarkProps) {
  return (
    <svg {...frame} className={className}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/** The Markdown mark: an "M" and a down arrow in a rounded frame. */
export function MarkdownMark({ className = "" }: MarkProps) {
  return (
    <svg {...frame} className={className}>
      <g {...line} strokeWidth={1.2}>
        <rect x="0.9" y="3.4" width="14.2" height="9.2" rx="1.6" />
        <path d="M3.4 10.2V5.8l1.9 2.3 1.9-2.3v4.4" />
        <path d="M11.4 5.8v4.2M9.7 8.5l1.7 1.7 1.7-1.7" />
      </g>
    </svg>
  );
}

/** A small arrow for links that leave the site. */
export function ExternalArrow({ className = "" }: MarkProps) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={className}>
      <path d="M2.5 7.5 7.5 2.5M3.75 2.5H7.5v3.75" {...line} strokeWidth={1.1} />
    </svg>
  );
}
