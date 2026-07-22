/**
 * Pure geometry for the agent-graph canvas overlay.
 *
 * Given the projected window rects (canvas-space, the same units the canvas uses
 * for floating/docked window placement) and a validated {@link AgentGraphOverlay},
 * this module produces:
 * - directed edge paths anchored on the source/target window borders (never
 *   drawn through the interior of the two connected rects), with an arrowhead
 *   and a kind-dependent bow so a `spawned` and a `mission` edge between the same
 *   pair stay visually distinct;
 * - group frames: a padded bounding box around the resolvable member windows;
 * - a minimap projection: window rects + the current viewport rectangle scaled
 *   into a small corner box.
 *
 * Everything DEGRADES rather than throwing. Overlay entries whose windowId has
 * no rect are skipped and counted in {@link AgentGraphSceneSkip}; a group with no
 * resolvable members is dropped; an edge with a missing endpoint is dropped.
 */
import type {
  AgentGraphEdgeKind,
  AgentGraphNodeStatus,
  AgentGraphOverlay,
  AgentGraphStatusSource,
} from "@tmux-ide/contracts";
import {
  canvasRectBounds,
  screenToCanvas,
  type CanvasPoint,
  type CanvasRect,
  type CanvasScaleRange,
  type CanvasViewportTransform,
} from "./canvas-interaction-geometry.ts";

/** A projected window rect keyed by its durable window id. */
export interface AgentGraphSceneRect {
  readonly windowId: string;
  readonly rect: CanvasRect;
}

/** A resolved graph node placed on a real window rect. */
export interface AgentGraphNodePlacement {
  readonly windowId: string;
  readonly rect: CanvasRect;
  readonly status: AgentGraphNodeStatus;
  readonly statusSource: AgentGraphStatusSource;
  readonly attention: boolean;
  readonly label: string | null;
}

/** A directed edge resolved to canvas-space anchor points and SVG path data. */
export interface AgentGraphEdgeGeometry {
  readonly from: string;
  readonly to: string;
  readonly kind: AgentGraphEdgeKind;
  /** Anchor on the source window border. */
  readonly source: CanvasPoint;
  /** Anchor on the target window border (the arrow tip). */
  readonly target: CanvasPoint;
  /** SVG `d` for the connector (a quadratic curve). */
  readonly path: string;
  /** SVG `d` for the filled arrowhead at the target anchor. */
  readonly arrow: string;
  /** True when either endpoint node asks for attention. */
  readonly attention: boolean;
}

/** A group frame resolved to a padded bounding box in canvas space. */
export interface AgentGraphGroupGeometry {
  readonly id: string;
  readonly label: string;
  readonly rect: CanvasRect;
  readonly memberCount: number;
}

/** How many overlay entries were dropped because a rect was missing. */
export interface AgentGraphSceneSkip {
  /** Overlay nodes whose windowId has no rect. */
  readonly nodes: number;
  /** Edges dropped because an endpoint had no rect. */
  readonly edges: number;
  /** Groups dropped because no member resolved to a rect. */
  readonly groups: number;
  /** Individual group members dropped because their rect was missing. */
  readonly groupMembers: number;
}

export interface AgentGraphScene {
  readonly nodes: readonly AgentGraphNodePlacement[];
  readonly edges: readonly AgentGraphEdgeGeometry[];
  readonly groups: readonly AgentGraphGroupGeometry[];
  readonly skipped: AgentGraphSceneSkip;
}

export interface AgentGraphSceneOptions {
  /** Padding (canvas units) added around a group's member bounding box. */
  readonly groupPadding?: number;
  /** Arrowhead length in canvas units. */
  readonly arrowSize?: number;
}

const DEFAULT_GROUP_PADDING = 20;
const DEFAULT_ARROW_SIZE = 9;
const ARROW_SPREAD = 0.45;
/** Fraction of the connector length used as the perpendicular bow. */
const EDGE_BOW_RATIO = 0.12;
const EDGE_BOW_MAX = 42;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function center(rect: CanvasRect): CanvasPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Point where the ray from a rect's center toward `toward` crosses the border. */
function rectBorderPoint(rect: CanvasRect, toward: CanvasPoint): CanvasPoint {
  const c = center(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const halfWidth = Math.max(0, rect.width / 2);
  const halfHeight = Math.max(0, rect.height / 2);
  if (dx === 0 && dy === 0) return c;
  const scaleX = dx !== 0 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function point(value: CanvasPoint): string {
  return `${round(value.x)} ${round(value.y)}`;
}

function edgeGeometry(
  from: string,
  to: string,
  kind: AgentGraphEdgeKind,
  fromRect: CanvasRect,
  toRect: CanvasRect,
  attention: boolean,
  arrowSize: number,
): AgentGraphEdgeGeometry {
  const fromCenter = center(fromRect);
  const toCenter = center(toRect);
  const source = rectBorderPoint(fromRect, toCenter);
  const target = rectBorderPoint(toRect, fromCenter);
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };

  // A kind-signed perpendicular bow keeps a spawned and a mission edge between
  // the same pair from overlapping. Fall back to the center axis when the
  // border anchors coincide (overlapping rects).
  const axisX = length > 0 ? dx : toCenter.x - fromCenter.x;
  const axisY = length > 0 ? dy : toCenter.y - fromCenter.y;
  const axisLength = Math.hypot(axisX, axisY) || 1;
  const bowMagnitude = Math.min(length * EDGE_BOW_RATIO, EDGE_BOW_MAX);
  const bow = (kind === "spawned" ? 1 : -1) * bowMagnitude;
  const control = {
    x: mid.x + (-axisY / axisLength) * bow,
    y: mid.y + (axisX / axisLength) * bow,
  };

  const tangentX = target.x - control.x;
  const tangentY = target.y - control.y;
  const angle = Math.atan2(tangentY, tangentX) || Math.atan2(axisY, axisX);
  const wingA = {
    x: target.x - arrowSize * Math.cos(angle - ARROW_SPREAD),
    y: target.y - arrowSize * Math.sin(angle - ARROW_SPREAD),
  };
  const wingB = {
    x: target.x - arrowSize * Math.cos(angle + ARROW_SPREAD),
    y: target.y - arrowSize * Math.sin(angle + ARROW_SPREAD),
  };

  return {
    from,
    to,
    kind,
    source: { x: round(source.x), y: round(source.y) },
    target: { x: round(target.x), y: round(target.y) },
    path: `M ${point(source)} Q ${point(control)} ${point(target)}`,
    arrow: `M ${point(target)} L ${point(wingA)} L ${point(wingB)} Z`,
    attention,
  };
}

/**
 * Project a validated overlay onto the supplied window rects. Pure and total —
 * missing rects degrade to skips rather than throwing.
 */
export function projectAgentGraphScene(
  overlay: AgentGraphOverlay,
  windowRects: readonly AgentGraphSceneRect[],
  options: AgentGraphSceneOptions = {},
): AgentGraphScene {
  const rectById = new Map(windowRects.map((entry) => [entry.windowId, entry.rect]));
  const groupPadding = Math.max(0, options.groupPadding ?? DEFAULT_GROUP_PADDING);
  const arrowSize = Math.max(1, options.arrowSize ?? DEFAULT_ARROW_SIZE);

  const nodes: AgentGraphNodePlacement[] = [];
  let skippedNodes = 0;
  for (const node of Object.values(overlay.nodes)) {
    const rect = rectById.get(node.windowId);
    if (!rect) {
      skippedNodes += 1;
      continue;
    }
    nodes.push({
      windowId: node.windowId,
      rect,
      status: node.status,
      statusSource: node.statusSource,
      attention: node.attention,
      label: node.label,
    });
  }

  const edges: AgentGraphEdgeGeometry[] = [];
  let skippedEdges = 0;
  for (const edge of overlay.edges) {
    const fromRect = rectById.get(edge.from);
    const toRect = rectById.get(edge.to);
    if (!fromRect || !toRect) {
      skippedEdges += 1;
      continue;
    }
    const attention = Boolean(
      overlay.nodes[edge.from]?.attention || overlay.nodes[edge.to]?.attention,
    );
    edges.push(edgeGeometry(edge.from, edge.to, edge.kind, fromRect, toRect, attention, arrowSize));
  }

  const groups: AgentGraphGroupGeometry[] = [];
  let skippedGroups = 0;
  let skippedGroupMembers = 0;
  for (const group of overlay.groups) {
    const memberRects: CanvasRect[] = [];
    for (const memberId of group.memberWindowIds) {
      const rect = rectById.get(memberId);
      if (!rect) {
        skippedGroupMembers += 1;
        continue;
      }
      memberRects.push(rect);
    }
    const bounds = canvasRectBounds(memberRects);
    if (!bounds) {
      skippedGroups += 1;
      continue;
    }
    groups.push({
      id: group.id,
      label: group.label,
      rect: {
        x: round(bounds.x - groupPadding),
        y: round(bounds.y - groupPadding),
        width: round(bounds.width + groupPadding * 2),
        height: round(bounds.height + groupPadding * 2),
      },
      memberCount: memberRects.length,
    });
  }

  return {
    nodes,
    edges,
    groups,
    skipped: {
      nodes: skippedNodes,
      edges: skippedEdges,
      groups: skippedGroups,
      groupMembers: skippedGroupMembers,
    },
  };
}

/** One window fill in the minimap, scaled to minimap pixels. */
export interface AgentGraphMinimapWindow {
  readonly windowId: string;
  readonly rect: CanvasRect;
  readonly status: AgentGraphNodeStatus | null;
  readonly attention: boolean;
}

export interface AgentGraphMinimap {
  /** World (canvas-space) bounds shown by the minimap. */
  readonly content: CanvasRect;
  /** Canvas-units-per-minimap-pixel scale. */
  readonly scale: number;
  readonly windows: readonly AgentGraphMinimapWindow[];
  /** The current viewport rectangle, in minimap pixels. */
  readonly viewportRect: CanvasRect;
  /** The minimap box dimensions the projection was fit into. */
  readonly size: { readonly width: number; readonly height: number };
}

export interface AgentGraphMinimapInput {
  readonly windows: readonly AgentGraphSceneRect[];
  readonly statusById: ReadonlyMap<string, AgentGraphNodeStatus>;
  readonly attentionById?: ReadonlyMap<string, boolean>;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly transform: CanvasViewportTransform;
  readonly size: { readonly width: number; readonly height: number };
  readonly scaleRange?: CanvasScaleRange;
  readonly padding?: number;
}

/**
 * Fit every window rect AND the current viewport region into a small box. The
 * viewport region is always part of the fitted bounds so the viewport rectangle
 * stays visible even when panned away from the windows. Returns null when there
 * is nothing to show.
 */
export function projectAgentGraphMinimap(input: AgentGraphMinimapInput): AgentGraphMinimap | null {
  const boxWidth = Math.max(1, input.size.width);
  const boxHeight = Math.max(1, input.size.height);
  const padding = Math.max(0, input.padding ?? 6);

  const viewportTopLeft = screenToCanvas({ x: 0, y: 0 }, input.transform, input.scaleRange);
  const viewportBottomRight = screenToCanvas(
    { x: input.viewport.width, y: input.viewport.height },
    input.transform,
    input.scaleRange,
  );
  const viewportWorld: CanvasRect = {
    x: viewportTopLeft.x,
    y: viewportTopLeft.y,
    width: Math.max(0, viewportBottomRight.x - viewportTopLeft.x),
    height: Math.max(0, viewportBottomRight.y - viewportTopLeft.y),
  };

  const content = canvasRectBounds([...input.windows.map((entry) => entry.rect), viewportWorld]);
  if (!content || content.width === 0 || content.height === 0) return null;

  const availableWidth = Math.max(1, boxWidth - padding * 2);
  const availableHeight = Math.max(1, boxHeight - padding * 2);
  const scale = Math.min(availableWidth / content.width, availableHeight / content.height);
  // Center the fitted content inside the padded box.
  const offsetX = padding + (availableWidth - content.width * scale) / 2;
  const offsetY = padding + (availableHeight - content.height * scale) / 2;

  const toMinimap = (rect: CanvasRect): CanvasRect => ({
    x: round(offsetX + (rect.x - content.x) * scale),
    y: round(offsetY + (rect.y - content.y) * scale),
    width: round(rect.width * scale),
    height: round(rect.height * scale),
  });

  return {
    content,
    scale,
    size: { width: boxWidth, height: boxHeight },
    windows: input.windows.map((entry) => ({
      windowId: entry.windowId,
      rect: toMinimap(entry.rect),
      status: input.statusById.get(entry.windowId) ?? null,
      attention: input.attentionById?.get(entry.windowId) ?? false,
    })),
    viewportRect: toMinimap(viewportWorld),
  };
}

/**
 * Map a click at minimap-pixel coordinates back to a viewport transform that
 * centers the corresponding canvas point. Scale is preserved.
 */
export function agentGraphMinimapPanTransform(
  minimap: AgentGraphMinimap,
  point: CanvasPoint,
  transform: CanvasViewportTransform,
  viewport: { readonly width: number; readonly height: number },
  padding = 6,
): CanvasViewportTransform {
  const availableWidth = Math.max(1, minimap.size.width - padding * 2);
  const availableHeight = Math.max(1, minimap.size.height - padding * 2);
  const offsetX = padding + (availableWidth - minimap.content.width * minimap.scale) / 2;
  const offsetY = padding + (availableHeight - minimap.content.height * minimap.scale) / 2;
  const canvasX = minimap.content.x + (point.x - offsetX) / minimap.scale;
  const canvasY = minimap.content.y + (point.y - offsetY) / minimap.scale;
  return {
    scale: transform.scale,
    x: viewport.width / 2 - canvasX * transform.scale,
    y: viewport.height / 2 - canvasY * transform.scale,
  };
}
