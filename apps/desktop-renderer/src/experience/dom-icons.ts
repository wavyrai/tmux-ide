import {
  Activity03Icon,
  ArrowExpandIcon,
  ArrowShrink02Icon,
  ArrowUpRight01Icon,
  BrowserIcon,
  Cancel01Icon,
  CommandIcon,
  Copy01Icon,
  File01Icon,
  GitCompareIcon,
  Home01Icon,
  LayoutBottomIcon,
  LayoutRightIcon,
  LayoutTopIcon,
  MinusSignIcon,
  MoreHorizontalIcon,
  MoveIcon,
  RefreshIcon,
  Search01Icon,
  SquareArrowExpand01Icon,
  SquareIcon,
  Target02Icon,
  TerminalIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { SEMANTIC_ICON_IDS, type SemanticIconId } from "@tmux-ide/contracts";

import { ICON_SIZE, ICON_STROKE_WIDTH, type IconArtwork } from "../ui-system/icon.tsx";

/**
 * Every semantic icon the DOM shell can name, bound to library artwork.
 *
 * The ids are the product's vocabulary and the artwork is an implementation
 * detail behind them — swapping a glyph is a one-line change here, and no
 * surface has to know. Sizes come from the shared ladder rather than bespoke
 * numbers, so a rail glyph and a header glyph are the same size everywhere.
 */
export const DOM_ICON_USAGE_SIZES = Object.freeze({
  pane: ICON_SIZE.control,
  tab: ICON_SIZE.control,
  rail: ICON_SIZE.surface,
  action: ICON_SIZE.control,
  nativeWindow: ICON_SIZE.control,
} as const);

export type DomIconUsage = keyof typeof DOM_ICON_USAGE_SIZES;
export type DomIconSize = (typeof DOM_ICON_USAGE_SIZES)[DomIconUsage];

export interface DomIconMetadata {
  readonly id: SemanticIconId;
  readonly label: string;
  readonly viewBox: "0 0 24 24";
  readonly size: 16;
  readonly usageSizes: Readonly<Record<DomIconUsage, DomIconSize>>;
  readonly strokeWidth: 2;
  readonly strokeLinecap: "round";
  readonly strokeLinejoin: "round";
  readonly fill: "none";
  readonly stroke: "currentColor";
  readonly artwork: IconArtwork;
}

export interface ResolvedDomIconMetadata extends Omit<DomIconMetadata, "size"> {
  readonly usage: DomIconUsage;
  readonly size: DomIconSize;
}

interface DomIconSpec {
  readonly label: string;
  readonly artwork: IconArtwork;
}

const ICON_SPECS = {
  home: { label: "Home", artwork: Home01Icon },
  terminals: { label: "Terminals", artwork: TerminalIcon },
  files: { label: "Files", artwork: File01Icon },
  changes: { label: "Changes", artwork: GitCompareIcon },
  missions: { label: "Missions", artwork: Target02Icon },
  activity: { label: "Activity", artwork: Activity03Icon },
  preview: { label: "Preview", artwork: ViewIcon },
  native: { label: "Native window", artwork: BrowserIcon },
  more: { label: "More", artwork: MoreHorizontalIcon },
  close: { label: "Close", artwork: Cancel01Icon },
  minimize: { label: "Minimize", artwork: MinusSignIcon },
  maximize: { label: "Maximize", artwork: SquareIcon },
  restore: { label: "Restore", artwork: ArrowShrink02Icon },
  // The three placement verbs read as one family: the glyph shows which edge
  // of the frame the pane ends up against.
  "split-right": { label: "Split right", artwork: LayoutRightIcon },
  "split-down": { label: "Split down", artwork: LayoutBottomIcon },
  dock: { label: "Dock", artwork: LayoutTopIcon },
  duplicate: { label: "Duplicate", artwork: Copy01Icon },
  float: { label: "Float", artwork: SquareArrowExpand01Icon },
  move: { label: "Move", artwork: MoveIcon },
  resize: { label: "Resize", artwork: ArrowExpandIcon },
  "pop-out": { label: "Pop out", artwork: ArrowUpRight01Icon },
  search: { label: "Search", artwork: Search01Icon },
  refresh: { label: "Refresh", artwork: RefreshIcon },
  command: { label: "Command palette", artwork: CommandIcon },
} satisfies Record<SemanticIconId, DomIconSpec>;

export const DOM_ICON_METADATA: Readonly<Record<SemanticIconId, DomIconMetadata>> = Object.freeze(
  Object.fromEntries(
    SEMANTIC_ICON_IDS.map((id) => {
      const spec = ICON_SPECS[id];
      return [
        id,
        Object.freeze({
          id,
          label: spec.label,
          viewBox: "0 0 24 24" as const,
          size: ICON_SIZE.control,
          usageSizes: DOM_ICON_USAGE_SIZES,
          strokeWidth: ICON_STROKE_WIDTH,
          strokeLinecap: "round" as const,
          strokeLinejoin: "round" as const,
          fill: "none" as const,
          stroke: "currentColor" as const,
          artwork: spec.artwork,
        }),
      ];
    }),
  ) as Record<SemanticIconId, DomIconMetadata>,
);

export function resolveDomIcon(
  id: SemanticIconId,
  usage: DomIconUsage = "action",
): ResolvedDomIconMetadata {
  const metadata = DOM_ICON_METADATA[id];
  return Object.freeze({ ...metadata, usage, size: metadata.usageSizes[usage] });
}
