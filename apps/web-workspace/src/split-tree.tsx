import * as stylex from "@stylexjs/stylex";
import { type Layout, leaves } from "@superlogical/shared/model";
import { type ReactNode, useRef, useState } from "react";
import { s } from "./styles";

interface Props {
  compact?: boolean;
  node: Layout;
  onResize: (id: string, ratio: number) => void;
  renderPane: (id: string) => ReactNode;
}
export function SplitTree({ node, renderPane, onResize, compact = false }: Props) {
  const element = useRef<HTMLDivElement>(null),
    [dragRatio, setDragRatio] = useState<number | null>(null);
  if (compact && node.type !== "leaf") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          height: "calc(100% + 16px)",
          margin: -8,
          overflowY: "auto",
          // Keep the scroller outside the glass shadow bounds.
          padding: 8,
        }}
      >
        {leaves(node).map((id) => (
          <div key={id} style={{ flex: "1 0 240px", minHeight: 240 }}>
            {renderPane(id)}
          </div>
        ))}
      </div>
    );
  }
  if (node.type === "leaf") {
    return renderPane(node.id);
  }
  const vertical = node.direction === "vertical",
    ratio = dragRatio ?? node.ratio;
  const clamp = (value: number) => Math.max(0.15, Math.min(0.85, value));
  return (
    <div ref={element} {...stylex.props(s.tree, vertical && s.vertical)}>
      <div {...stylex.props(s.branch)} style={{ flex: `${ratio} 1 0%` }}>
        <SplitTree node={node.first} onResize={onResize} renderPane={renderPane} />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: This focusable adjustable splitter implements the interactive ARIA separator pattern, not a document rule. */}
      <div
        {...stylex.props(s.handle, vertical && s.handleVertical)}
        aria-label={vertical ? "Resize rows" : "Resize columns"}
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuemax={85}
        aria-valuemin={15}
        aria-valuenow={Math.round(ratio * 100)}
        onDoubleClick={() => {
          setDragRatio(null);
          onResize(node.id, 0.5);
        }}
        onKeyDown={(e) => {
          if (e.key === "Home") {
            e.preventDefault();
            onResize(node.id, 0.5);
            return;
          }
          const delta =
            e.key === (vertical ? "ArrowDown" : "ArrowRight")
              ? 0.05
              : e.key === (vertical ? "ArrowUp" : "ArrowLeft")
                ? -0.05
                : 0;
          if (delta) {
            e.preventDefault();
            onResize(node.id, clamp(node.ratio + delta));
          }
        }}
        onPointerCancel={() => setDragRatio(null)}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragRatio(node.ratio);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
            return;
          }
          const container = element.current;
          if (!container) {
            return;
          }
          const rect = container.getBoundingClientRect();
          setDragRatio(
            clamp(
              vertical
                ? (e.clientY - rect.top) / rect.height
                : (e.clientX - rect.left) / rect.width,
            ),
          );
        }}
        onPointerUp={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
            return;
          }
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (dragRatio !== null) {
            onResize(node.id, dragRatio);
          }
          setDragRatio(null);
        }}
        role="separator"
        tabIndex={0}
      >
        <span {...stylex.props(s.handleLine, vertical && s.handleLineVertical)} />
      </div>
      <div {...stylex.props(s.branch)} style={{ flex: `${1 - ratio} 1 0%` }}>
        <SplitTree node={node.second} onResize={onResize} renderPane={renderPane} />
      </div>
    </div>
  );
}
