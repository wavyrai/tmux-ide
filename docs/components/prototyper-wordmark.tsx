/**
 * The Prototyper wordmark — custom-drawn letterforms (not a font), so it
 * scales cleanly at any size. Aspect ratio is locked at 249:50.
 *
 * The 4.8 KB path lives once in public/prototyper-wordmark.svg and is
 * referenced with <use>, so it is not inlined (twice, in HTML and the RSC
 * payload) by every page that shows the banner and footer. The path carries no
 * paint of its own: fill and stroke still inherit currentColor from the <g>.
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
  const height = typeof width === "number" ? (width * 50) / 249 : undefined;
  // The outline stroke is centered on paths that reach the original 0–249 ×
  // 0–50 drawing bounds. Give only that variant a small optical safe area so
  // its outer half-stroke is never clipped by the SVG viewport.
  const viewBox = outline ? "-0.5 -0.5 250 51" : "0 0 249 50";

  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      overflow={outline ? "visible" : undefined}
      aria-hidden
    >
      <g
        fill={outline ? "none" : "currentColor"}
        fillRule="nonzero"
        stroke={outline ? "currentColor" : undefined}
        strokeWidth={outline ? 0.45 : undefined}
        vectorEffect="non-scaling-stroke"
        shapeRendering="geometricPrecision"
      >
        <use href="/prototyper-wordmark.svg#wordmark" />
      </g>
    </svg>
  );
}
