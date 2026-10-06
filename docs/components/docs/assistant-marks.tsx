/**
 * Small monochrome marks for the assistants in "Explore with AI". They are
 * simplified, decorative glyphs drawn for this site (aria-hidden); the link
 * text carries the name.
 */
type MarkProps = { className?: string };

const base = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** Three interlocking loops. */
export function ChatGptMark({ className }: MarkProps) {
  return (
    <svg {...base} className={className}>
      <ellipse cx="8" cy="8" rx="6.25" ry="2.75" />
      <ellipse cx="8" cy="8" rx="6.25" ry="2.75" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.25" ry="2.75" transform="rotate(120 8 8)" />
    </svg>
  );
}

/** A radiating burst. */
export function ClaudeMark({ className }: MarkProps) {
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <svg {...base} strokeWidth={1.5} className={className}>
      {rays.map((angle, index) => (
        <path
          key={angle}
          d={`M8 ${index % 2 === 0 ? 1.5 : 2.75}V6.25`}
          transform={`rotate(${angle} 8 8)`}
        />
      ))}
    </svg>
  );
}

/** A folded, book-like spine. */
export function PerplexityMark({ className }: MarkProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8 1.5v13" />
      <path d="M2.75 4.25 8 8l5.25-3.75" />
      <path d="M2.75 4.25v6.5L8 14.5l5.25-3.75v-6.5" />
      <path d="M2.75 4.25h10.5" />
    </svg>
  );
}
