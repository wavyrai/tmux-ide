import type { RGBA } from "../../types.ts";

export function rgbaToCSS(color: RGBA): string {
  if (color.a === 0) return "transparent";
  if (color.a === 255 || color.a === undefined) {
    return `rgb(${color.r},${color.g},${color.b})`;
  }
  return `rgba(${color.r},${color.g},${color.b},${(color.a / 255).toFixed(2)})`;
}

export function attributesToStyle(attrs: number): Record<string, string> {
  const style: Record<string, string> = {};
  if (attrs & 1) style["font-weight"] = "bold"; // BOLD
  if (attrs & 2) style.opacity = "0.6"; // DIM
  if (attrs & 4) style["font-style"] = "italic"; // ITALIC

  // Compose text-decoration: underline and line-through can coexist
  const decorations: string[] = [];
  if (attrs & 8) decorations.push("underline"); // UNDERLINE
  if (attrs & 128) decorations.push("line-through"); // STRIKETHROUGH
  if (decorations.length > 0) style["text-decoration"] = decorations.join(" ");

  if (attrs & 16) style.animation = "blink 1s step-end infinite"; // BLINK
  if (attrs & 32) style.filter = "invert(1)"; // INVERSE
  if (attrs & 64) style.visibility = "hidden"; // HIDDEN
  return style;
}
