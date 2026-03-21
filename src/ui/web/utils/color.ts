import type { RGBA } from "../../types.ts";

export function rgbaToCSS(color: RGBA): string {
  if (color.a === 0) return "transparent";
  if (color.a === 255 || color.a === undefined) {
    return `rgb(${color.r},${color.g},${color.b})`;
  }
  return `rgba(${color.r},${color.g},${color.b},${(color.a / 255).toFixed(2)})`;
}

export function attributesToStyle(
  attrs: number,
): Record<string, string> {
  const style: Record<string, string> = {};
  if (attrs & 1) style["font-weight"] = "bold"; // BOLD
  if (attrs & 2) style.opacity = "0.6"; // DIM
  if (attrs & 4) style["font-style"] = "italic"; // ITALIC
  if (attrs & 8) style["text-decoration"] = "underline"; // UNDERLINE
  if (attrs & 128) style["text-decoration"] = "line-through"; // STRIKETHROUGH
  return style;
}
