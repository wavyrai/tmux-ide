import { SPRITE } from "./sprite-url";

/**
 * Icons from one cached SVG sprite (components/icons/sprite.svg). Importing
 * the file gives a content-hashed /_next/static URL, so the paths download
 * once and stay out of every page's HTML and RSC payload. Symbols paint with
 * currentColor, which a <use> instance inherits from its parent.
 *
 * Symbols: github, docs, cursor, copy, cursor-arrow (the demos' multiplayer
 * pointer), and the harness marks claude-code (brand fill), codex and
 * opencode (currentColor). Add new ones to the sprite with
 * their own viewBox and reference them by id.
 */
export type SpriteName =
  | "github"
  | "docs"
  | "cursor"
  | "copy"
  | "cursor-arrow"
  | "claude-code"
  | "codex"
  | "opencode";

export function SpriteIcon({
  name,
  size = 14,
  className,
}: {
  name: SpriteName;
  size?: number;
  className?: string;
}) {
  return (
    <svg width={size} height={size} aria-hidden className={className}>
      <use href={`${SPRITE}#${name}`} />
    </svg>
  );
}
