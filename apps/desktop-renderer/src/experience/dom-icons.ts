import { SEMANTIC_ICON_IDS, type SemanticIconId } from "@tmux-ide/contracts";

export const DOM_ICON_USAGE_SIZES = Object.freeze({
  pane: 12,
  tab: 12,
  rail: 12,
  action: 12,
  nativeWindow: 10,
} as const);

export type DomIconUsage = keyof typeof DOM_ICON_USAGE_SIZES;
export type DomIconSize = (typeof DOM_ICON_USAGE_SIZES)[DomIconUsage];

export interface DomIconMetadata {
  readonly id: SemanticIconId;
  readonly label: string;
  readonly viewBox: "0 0 16 16";
  readonly size: 12;
  readonly usageSizes: Readonly<Record<DomIconUsage, DomIconSize>>;
  readonly strokeWidth: 1.5;
  readonly strokeLinecap: "round";
  readonly strokeLinejoin: "round";
  readonly fill: "none";
  readonly stroke: "currentColor";
  readonly paths: readonly string[];
}

export interface ResolvedDomIconMetadata extends Omit<DomIconMetadata, "size"> {
  readonly usage: DomIconUsage;
  readonly size: DomIconSize;
}

type DomIconSpec = Pick<DomIconMetadata, "label" | "paths">;

const ICON_SPECS = {
  home: { label: "Home", paths: ["M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4Z"] },
  terminals: {
    label: "Terminals",
    paths: ["M2 3.25h12v9.5H2Z", "m4.25 6 2 2-2 2", "M8.25 10.25h3.5"],
  },
  files: {
    label: "Files",
    paths: ["M2.5 3.25h4l1.25 1.5h5.75v8H2.5Z"],
  },
  changes: {
    label: "Changes",
    paths: ["M5 2.5v11", "m3-8 2-2 2 2", "m4 6 2 2-2 2", "M10 4.5v3", "M6 8.5v3"],
  },
  missions: {
    label: "Missions",
    paths: ["M8 2.25 13.75 8 8 13.75 2.25 8Z", "M8 5.5v5", "M5.5 8h5"],
  },
  activity: {
    label: "Activity",
    paths: ["M1.75 8h2.5l1.5-4 3 8 1.5-4h4"],
  },
  preview: {
    label: "Preview",
    paths: [
      "M1.5 8s2.25-3.75 6.5-3.75S14.5 8 14.5 8 12.25 11.75 8 11.75 1.5 8 1.5 8Z",
      "M8 6.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z",
    ],
  },
  native: {
    label: "Native window",
    paths: ["M2 3h12v10H2Z", "M2 5.5h12", "M4 4.25h.01", "M5.5 4.25h.01"],
  },
  more: { label: "More", paths: ["M2.75 8h.5M7.75 8h.5M12.75 8h.5"] },
  close: { label: "Close", paths: ["m3.5 3.5 9 9", "m12.5 3.5-9 9"] },
  minimize: { label: "Minimize", paths: ["M3 11.5h10"] },
  maximize: { label: "Maximize", paths: ["M3 3h10v10H3Z"] },
  restore: {
    label: "Restore",
    paths: ["M5 3h8v8h-2", "M3 5h8v8H3Z"],
  },
  "split-right": {
    label: "Split right",
    paths: ["M2.5 3h11v10h-11Z", "M8 3v10", "m10.5 6 2 2-2 2"],
  },
  "split-down": {
    label: "Split down",
    paths: ["M2.5 3h11v10h-11Z", "M2.5 8h11", "m6 10.5 2 2 2-2"],
  },
  duplicate: {
    label: "Duplicate",
    paths: ["M5 5h8v8H5Z", "M3 11H2.5V3H10v.5"],
  },
  dock: {
    label: "Dock",
    paths: ["M2.5 3h11v10h-11Z", "M2.5 9.5h11", "m6 5.5 2 2 2-2"],
  },
  float: {
    label: "Float",
    paths: ["M4.5 5h8v7.5h-8Z", "M2.5 10V3.5H10", "m9 3.5 3.5 0V7"],
  },
  move: {
    label: "Move",
    paths: [
      "M8 1.75v12.5M1.75 8h12.5",
      "m5.75 4.25 2.25-2.5 2.25 2.5",
      "m5.75 11.75 2.25 2.5 2.25-2.5",
      "m4.25 5.75-2.5 2.25 2.5 2.25",
      "m11.75 5.75 2.5 2.25-2.5 2.25",
    ],
  },
  resize: {
    label: "Resize",
    paths: ["M3 6V3h3", "M10 3h3v3", "M13 10v3h-3", "M6 13H3v-3"],
  },
  "pop-out": {
    label: "Pop out",
    paths: ["M7 3H3v10h10V9", "M9 3h4v4", "m7 9 6-6"],
  },
  search: {
    label: "Search",
    paths: ["M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z", "m10.5 10.5 3 3"],
  },
  refresh: {
    label: "Refresh",
    paths: ["M13 5.5V2.75l-1.5 1.5A5.25 5.25 0 1 0 13 10", "M13 2.75h-2.75"],
  },
  command: {
    label: "Command palette",
    paths: [
      "M5 5.25A2.25 2.25 0 1 1 2.75 3 2.25 2.25 0 0 1 5 5.25v5.5A2.25 2.25 0 1 1 2.75 13 2.25 2.25 0 0 1 5 10.75h6A2.25 2.25 0 1 1 13.25 13 2.25 2.25 0 0 1 11 10.75v-5.5A2.25 2.25 0 1 1 13.25 3 2.25 2.25 0 0 1 11 5.25Z",
    ],
  },
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
          viewBox: "0 0 16 16" as const,
          size: 12 as const,
          usageSizes: DOM_ICON_USAGE_SIZES,
          strokeWidth: 1.5 as const,
          strokeLinecap: "round" as const,
          strokeLinejoin: "round" as const,
          fill: "none" as const,
          stroke: "currentColor" as const,
          paths: Object.freeze([...spec.paths]),
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
