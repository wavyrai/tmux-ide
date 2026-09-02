/**
 * The dither field — a tile of pixel cells in scattered greys. The hand-placed,
 * non-uniform layout is what keeps it reading as dither rather than as a regular
 * halftone grid.
 *
 * Two inks, because the two surfaces have different jobs:
 *
 *   LIGHT (white cells) — for the always-black top banner.
 *   INK   (black cells) — for the footer band, which follows the page theme, so
 *                         the cells must darken a light surface and lighten a
 *                         dark one. A single white tile would vanish on white.
 */
function tile(fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" shape-rendering="crispEdges">
  <g fill="${fill}">
    <rect x="1" y="2" width="2" height="2" opacity=".26"/>
    <rect x="7" y="0" width="2" height="2" opacity=".14"/>
    <rect x="13" y="3" width="2" height="2" opacity=".3"/>
    <rect x="19" y="1" width="2" height="2" opacity=".12"/>
    <rect x="4" y="7" width="2" height="2" opacity=".18"/>
    <rect x="10" y="9" width="2" height="2" opacity=".28"/>
    <rect x="16" y="6" width="2" height="2" opacity=".1"/>
    <rect x="22" y="8" width="2" height="2" opacity=".22"/>
    <rect x="2" y="13" width="2" height="2" opacity=".12"/>
    <rect x="8" y="15" width="2" height="2" opacity=".24"/>
    <rect x="14" y="12" width="2" height="2" opacity=".16"/>
    <rect x="20" y="14" width="2" height="2" opacity=".3"/>
    <rect x="5" y="19" width="2" height="2" opacity=".28"/>
    <rect x="11" y="21" width="2" height="2" opacity=".13"/>
    <rect x="17" y="18" width="2" height="2" opacity=".2"/>
    <rect x="23" y="20" width="2" height="2" opacity=".15"/>
  </g>
</svg>`;
}

const url = (fill: string) => `url("data:image/svg+xml,${encodeURIComponent(tile(fill))}")`;

/** White cells — reads on black. */
export const DITHER_URL = url("#fff");
/** Black cells — reads on a light surface. */
export const DITHER_URL_INK = url("#000");

export const DITHER_SIZE = "24px 24px";

/** Black on the left, the dither fading in toward the right edge (the banner). */
export const DITHER_MASK_RIGHT =
  "linear-gradient(to right, transparent 0%, transparent 18%, rgba(0,0,0,0.35) 42%, rgba(0,0,0,0.75) 70%, black 100%)";

/** Dense at the top, fading down into the surface (the footer band). */
export const DITHER_MASK_DOWN =
  "linear-gradient(to bottom, black 0%, rgba(0,0,0,0.5) 45%, transparent 100%)";
