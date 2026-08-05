import { For, mergeProps, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

/**
 * The icon system.
 *
 * Icon artwork comes from a real stroke-style library rather than hand-authored
 * path strings, and every glyph is drawn through this one component so weight
 * and size stay uniform and the artwork stays swappable. The library ships its
 * nodes as `[tag, attributes]` pairs on a 24-unit grid.
 *
 * Stroke presentation is owned by the root `<svg>`, never by the nodes: the
 * library bakes its own 1.5 weight into every path, so those attributes are
 * dropped on the way through. That is what makes `strokeWidth` here a real
 * control instead of a suggestion.
 */

/** One `[tag, attributes]` pair as the icon library ships it. */
export type IconNode = readonly [string, Readonly<Record<string, string | number>>];

/** A complete glyph: the node list for one icon. */
export type IconArtwork = readonly IconNode[];

/**
 * The size ladder, measured from the source design language.
 *
 * `dense` is for captions and meta rows, `control` is the default that buttons
 * and list rows enforce structurally, `surface` and `header` are for panel and
 * dialog headers, and `empty`/`hero` are the decorative sizes — those two drop
 * to a lighter stroke so a large glyph does not read as a slab.
 */
export const ICON_SIZE = Object.freeze({
  dense: 14,
  control: 16,
  surface: 20,
  header: 24,
  empty: 32,
  hero: 40,
} as const);

export type IconSizeName = keyof typeof ICON_SIZE;

/** The default weight. Large decorative glyphs step down to this lighter one. */
export const ICON_STROKE_WIDTH = 2;
export const ICON_STROKE_WIDTH_LARGE = 1.75;

/** Presentation attributes the root owns; nodes carrying them are overruled. */
const ROOT_OWNED = new Set(["stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "key"]);

const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset",
  fillRule: "fill-rule",
  clipRule: "clip-rule",
  clipPath: "clip-path",
};

/** Geometry and fill survive; presentation the root owns is stripped. */
export function iconNodeAttributes(
  attributes: Readonly<Record<string, string | number>>,
): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (ROOT_OWNED.has(name)) continue;
    kept[ATTRIBUTE_NAMES[name] ?? name] = value;
  }
  return kept;
}

export interface IconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  readonly icon: IconArtwork;
  /** Pixel size, or a name from the ladder. Defaults to the 16px control step. */
  readonly size?: number | IconSizeName;
  readonly strokeWidth?: number;
  /**
   * An accessible name. Omitted, the glyph is decorative and hidden — which is
   * correct whenever the affordance around it already carries a label.
   */
  readonly label?: string;
  readonly class?: string;
}

export function resolveIconSize(size: number | IconSizeName | undefined): number {
  if (size === undefined) return ICON_SIZE.control;
  return typeof size === "number" ? size : ICON_SIZE[size];
}

export function Icon(props: IconProps): JSX.Element {
  const merged = mergeProps({ size: ICON_SIZE.control as number | IconSizeName }, props);
  const [local, rest] = splitProps(merged, ["icon", "size", "strokeWidth", "label", "class"]);
  const size = () => resolveIconSize(local.size);
  const strokeWidth = () =>
    local.strokeWidth ?? (size() >= ICON_SIZE.empty ? ICON_STROKE_WIDTH_LARGE : ICON_STROKE_WIDTH);

  return (
    <svg
      {...rest}
      class={local.class}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth()}
      stroke-linecap="round"
      stroke-linejoin="round"
      role={local.label ? "img" : undefined}
      aria-label={local.label}
      aria-hidden={local.label ? undefined : "true"}
    >
      <For each={local.icon}>
        {(node) => <Dynamic component={node[0]} {...iconNodeAttributes(node[1])} />}
      </For>
    </svg>
  );
}
