import type { CSSProperties } from "react";

/**
 * The Prototyper wordmark — custom-drawn letterforms (not a font), so it
 * scales cleanly at any size. Aspect ratio is locked at 249:50.
 *
 * The drawing lives in public/brand/ and paints through a CSS mask filled
 * with currentColor. That keeps colour and hover inheritance identical to an
 * inline SVG while the ~5 KB of path data is fetched once and cached, instead
 * of being repeated in every page's HTML and RSC payload (banner and footer
 * render on every route; the home page HTML budget is 28 KB gzip).
 */
export function PrototyperWordmark({
  width = 104,
  outline = false,
  className,
}: {
  width?: number | string;
  outline?: boolean;
  className?: string;
}) {
  // The outline file carries a small optical safe area (−0.5 … 250 × 51) so
  // its centred hairline stroke is never clipped at the drawing bounds.
  const mask = `url(/brand/prototyper-wordmark${outline ? "-outline" : ""}.svg)`;
  const style: CSSProperties = {
    display: "inline-block",
    width,
    aspectRatio: outline ? "250 / 51" : "249 / 50",
    backgroundColor: "currentColor",
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: "100% 100%",
    WebkitMaskSize: "100% 100%",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    forcedColorAdjust: "none",
  };

  return <span aria-hidden className={className} style={style} />;
}
