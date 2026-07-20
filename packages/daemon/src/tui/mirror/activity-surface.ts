import stringWidth from "string-width";

export type ActivitySurfaceVariant = "compact" | "standard" | "wide";
export type ActivitySurfaceState = "loading" | "empty" | "error" | "ready";
export type ActivityRowStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export interface ActivityRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ActivityRowDtoBase {
  /** Stable adapter-owned identity. */
  id: string;
  /** Monotonic adapter-owned order. Larger values are newer. */
  sequence: number;
  /** Already-formatted display text, for example `12:48` or `2m ago`. */
  timestampText: string;
  message: string;
  detail?: string;
  status: ActivityRowStatus;
  attention?: boolean;
}

export interface ActivityAgentRowDto extends ActivityRowDtoBase {
  kind: "agent";
  agent: string;
}

export interface ActivityEventRowDto extends ActivityRowDtoBase {
  kind: "event";
  source: string;
}

/**
 * Runtime-neutral row boundary. Adapters may combine agent lifecycle and mission
 * events before they reach this projection; this module never reads tmux,
 * command-center, or mission persistence directly.
 */
export type ActivityRowDto = ActivityAgentRowDto | ActivityEventRowDto;

export interface ActivitySurfaceInput {
  width: number;
  height: number;
  state: ActivitySurfaceState;
  rows: readonly ActivityRowDto[];
  selectedRowId: string | null;
  scrollOffset: number;
  message?: string;
}

export interface ActivityProjectedRow extends ActivityRect {
  id: string;
  kind: ActivityRowDto["kind"];
  rowIndex: number;
  sequence: number;
  timestampText: string;
  status: ActivityRowStatus;
  statusText: string;
  sourceText: string;
  label: string;
  meta: string;
  detail: string;
  selected: boolean;
  attention: boolean;
}

export interface ActivityScrollbarProjection extends ActivityRect {
  glyphs: readonly string[];
}

export interface ActivitySurfaceProjection {
  width: number;
  height: number;
  variant: ActivitySurfaceVariant;
  state: ActivitySurfaceState;
  header: ActivityRect;
  body: ActivityRect;
  list: ActivityRect;
  footer: ActivityRect;
  scrollbar: ActivityScrollbarProjection;
  title: string;
  summary: string;
  message: string;
  totalRows: number;
  attentionCount: number;
  statusCounts: Readonly<Record<ActivityRowStatus, number>>;
  selectedRowId: string | null;
  selectedRowIndex: number;
  requestedScrollOffset: number;
  scrollOffset: number;
  maximumScrollOffset: number;
  rows: readonly ActivityProjectedRow[];
  footerText: string;
}

export interface ActivityRowHit {
  kind: "row";
  rowId: string;
  rowIndex: number;
  sequence: number;
}

const STATUS_ORDER: readonly ActivityRowStatus[] = [
  "blocked",
  "working",
  "done",
  "idle",
  "unknown",
];

export function activitySurfaceVariant(width: number, height: number): ActivitySurfaceVariant {
  const safeWidth = nonNegativeInteger(width);
  const safeHeight = nonNegativeInteger(height);
  if (safeWidth >= 140 && safeHeight >= 14) return "wide";
  if (safeWidth >= 80 && safeHeight >= 9) return "standard";
  return "compact";
}

/** Deterministic newest-first order, independent of the adapter's arrival order. */
export function orderActivityRows(rows: readonly ActivityRowDto[]): readonly ActivityRowDto[] {
  return rows
    .map((row, inputIndex) => ({ row, inputIndex, sequence: finiteSequence(row.sequence) }))
    .sort(
      (left, right) =>
        right.sequence - left.sequence ||
        compareStableId(left.row.id, right.row.id) ||
        left.inputIndex - right.inputIndex,
    )
    .map((entry) => entry.row);
}

/** Normalize adapter timestamps into one epoch-millisecond ordering domain.
 * Agent `since` values are epoch seconds; mission events supply ISO timestamps. */
export function activityOrderSequence(
  timestamp: number | string | null | undefined,
  fallback = 0,
): number {
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.floor(parsed) : finiteSequence(fallback);
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const milliseconds = Math.abs(timestamp) < 10_000_000_000 ? timestamp * 1_000 : timestamp;
    return Math.floor(milliseconds);
  }
  return finiteSequence(fallback);
}

export function clampActivityScrollOffset(
  rowCount: number,
  viewportRows: number,
  requested: number,
): number {
  const maximum = Math.max(0, nonNegativeInteger(rowCount) - nonNegativeInteger(viewportRows));
  return clamp(nonNegativeInteger(requested), 0, maximum);
}

export function projectActivitySurface(input: ActivitySurfaceInput): ActivitySurfaceProjection {
  const width = nonNegativeInteger(input.width);
  const height = nonNegativeInteger(input.height);
  const variant = activitySurfaceVariant(width, height);
  const headerHeight = Math.min(1, height);
  const footerHeight = height >= 4 ? 1 : 0;
  const bodyY = headerHeight;
  const bodyHeight = Math.max(0, height - headerHeight - footerHeight);
  const orderedRows = orderActivityRows(input.rows);
  const resolvedState: ActivitySurfaceState =
    input.state === "ready" && orderedRows.length === 0 ? "empty" : input.state;
  const rowSource = resolvedState === "ready" ? orderedRows : [];
  const requestedScrollOffset = nonNegativeInteger(input.scrollOffset);
  const maximumScrollOffset = Math.max(0, rowSource.length - bodyHeight);
  const selectedRowIndex =
    input.selectedRowId === null
      ? -1
      : rowSource.findIndex((row) => row.id === input.selectedRowId);
  let scrollOffset = clampActivityScrollOffset(rowSource.length, bodyHeight, requestedScrollOffset);
  if (selectedRowIndex >= 0 && bodyHeight > 0) {
    if (selectedRowIndex < scrollOffset) scrollOffset = selectedRowIndex;
    if (selectedRowIndex >= scrollOffset + bodyHeight) {
      scrollOffset = selectedRowIndex - bodyHeight + 1;
    }
    scrollOffset = clamp(scrollOffset, 0, maximumScrollOffset);
  }
  const scrollbarWidth = rowSource.length > bodyHeight && bodyHeight > 0 && width > 0 ? 1 : 0;
  const listWidth = Math.max(0, width - scrollbarWidth);
  const body: ActivityRect = { x: 0, y: bodyY, width, height: bodyHeight };
  const list: ActivityRect = { x: 0, y: bodyY, width: listWidth, height: bodyHeight };
  const visible = rowSource.slice(scrollOffset, scrollOffset + bodyHeight);
  const projectedRows = visible.map((row, visibleIndex) =>
    projectActivityRow({
      row,
      rowIndex: scrollOffset + visibleIndex,
      y: list.y + visibleIndex,
      width: list.width,
      variant,
      selected: row.id === input.selectedRowId,
    }),
  );
  const statusCounts = countStatuses(orderedRows);
  const attentionCount = orderedRows.filter((row) => row.attention).length;
  const summary = activitySummary(resolvedState, orderedRows.length, attentionCount, statusCounts);
  return {
    width,
    height,
    variant,
    state: resolvedState,
    header: { x: 0, y: 0, width, height: headerHeight },
    body,
    list,
    footer: { x: 0, y: Math.max(0, height - footerHeight), width, height: footerHeight },
    scrollbar: {
      x: list.width,
      y: body.y,
      width: scrollbarWidth,
      height: body.height,
      glyphs: activityScrollbarGlyphs(rowSource.length, bodyHeight, scrollOffset),
    },
    title: "Activity",
    summary,
    message: activityMessage(resolvedState, input.message),
    totalRows: orderedRows.length,
    attentionCount,
    statusCounts,
    selectedRowId: selectedRowIndex >= 0 ? input.selectedRowId : null,
    selectedRowIndex,
    requestedScrollOffset,
    scrollOffset,
    maximumScrollOffset,
    rows: projectedRows,
    footerText: activityFooterText(variant, rowSource.length, scrollOffset, projectedRows.length),
  };
}

/** Local-cell row hit testing. Header, footer, scrollbar, and blank body cells are inert. */
export function activityRowHitTest(
  projection: ActivitySurfaceProjection,
  x: number,
  y: number,
): ActivityRowHit | null {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (
    cellX < projection.list.x ||
    cellX >= projection.list.x + projection.list.width ||
    cellY < projection.list.y ||
    cellY >= projection.list.y + projection.list.height
  ) {
    return null;
  }
  const row = projection.rows.find(
    (candidate) => cellY >= candidate.y && cellY < candidate.y + candidate.height,
  );
  return row
    ? { kind: "row", rowId: row.id, rowIndex: row.rowIndex, sequence: row.sequence }
    : null;
}

function projectActivityRow(input: {
  row: ActivityRowDto;
  rowIndex: number;
  y: number;
  width: number;
  variant: ActivitySurfaceVariant;
  selected: boolean;
}): ActivityProjectedRow {
  const sourceText = normalizedText(
    input.row.kind === "agent" ? input.row.agent : input.row.source,
    input.row.kind,
  );
  const message = normalizedText(input.row.message, "activity update");
  const detail = normalizedText(input.row.detail ?? "", "");
  const attentionPrefix = input.row.attention ? "! " : "";
  const kindText = input.row.kind === "agent" ? "agent" : "event";
  const labelText =
    input.variant === "compact"
      ? `${attentionPrefix}${sourceText}: ${message}`
      : input.variant === "standard"
        ? `${attentionPrefix}${kindText} ${sourceText} · ${message}`
        : `${attentionPrefix}${kindText} ${sourceText} · ${message}${detail ? ` — ${detail}` : ""}`;
  const timestampText = normalizedText(input.row.timestampText, "—");
  const statusText = input.row.status;
  const meta =
    input.variant === "compact"
      ? `${timestampText} ${statusText}`
      : `${timestampText} · ${statusText}`;
  return {
    id: input.row.id,
    kind: input.row.kind,
    rowIndex: input.rowIndex,
    sequence: finiteSequence(input.row.sequence),
    timestampText,
    status: input.row.status,
    statusText,
    sourceText,
    label: clipActivityText(labelText, Math.max(0, input.width - 2)),
    meta: clipActivityText(meta, Math.max(0, input.width - 2)),
    detail,
    selected: input.selected,
    attention: input.row.attention ?? false,
    x: 0,
    y: input.y,
    width: input.width,
    height: 1,
  };
}

function activitySummary(
  state: ActivitySurfaceState,
  total: number,
  attention: number,
  statuses: Readonly<Record<ActivityRowStatus, number>>,
): string {
  if (state === "loading") return "syncing agent and mission activity";
  if (state === "error") return "activity unavailable";
  if (state === "empty") return "no activity yet";
  const parts = [`${total} ${total === 1 ? "update" : "updates"}`];
  if (attention > 0) parts.push(`${attention} attention`);
  for (const status of STATUS_ORDER) {
    if (statuses[status] > 0 && (status === "blocked" || status === "working")) {
      parts.push(`${statuses[status]} ${status}`);
    }
  }
  return parts.join(" · ");
}

function activityMessage(state: ActivitySurfaceState, message: string | undefined): string {
  const normalized = message?.trim();
  if (normalized) return normalized;
  if (state === "loading") return "Loading recent agent and mission events…";
  if (state === "error") return "Activity could not be loaded. Try refreshing the workspace.";
  if (state === "empty") return "Agent work and mission events will appear here.";
  return "Newest activity first";
}

function activityFooterText(
  variant: ActivitySurfaceVariant,
  total: number,
  scrollOffset: number,
  visibleRows: number,
): string {
  const range =
    total === 0
      ? "0 updates"
      : `${scrollOffset + 1}-${Math.min(total, scrollOffset + visibleRows)} of ${total}`;
  if (variant === "compact") return range;
  if (variant === "standard") return `j/k select · ${range}`;
  return `j/k select · enter inspect · ${range}`;
}

function countStatuses(
  rows: readonly ActivityRowDto[],
): Readonly<Record<ActivityRowStatus, number>> {
  const counts: Record<ActivityRowStatus, number> = {
    blocked: 0,
    working: 0,
    done: 0,
    idle: 0,
    unknown: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function activityScrollbarGlyphs(
  totalRows: number,
  viewportRows: number,
  scrollOffset: number,
): readonly string[] {
  if (viewportRows <= 0 || totalRows <= viewportRows) return [];
  const thumbHeight = Math.max(1, Math.floor((viewportRows / totalRows) * viewportRows));
  const maximumOffset = Math.max(1, totalRows - viewportRows);
  const thumbTop = Math.min(
    viewportRows - thumbHeight,
    Math.floor((scrollOffset / maximumOffset) * (viewportRows - thumbHeight)),
  );
  return Array.from({ length: viewportRows }, (_, index) =>
    index >= thumbTop && index < thumbTop + thumbHeight ? "█" : "░",
  );
}

function normalizedText(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function clipActivityText(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  const limit = Math.max(0, width - 1);
  let result = "";
  let used = 0;
  for (const segment of graphemes(text)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > limit) break;
    result += segment;
    used += segmentWidth;
  }
  return `${result}…`;
}

function graphemes(text: string): readonly string[] {
  if (Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (entry) => entry.segment,
    );
  }
  return [...text];
}

function finiteSequence(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function compareStableId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
