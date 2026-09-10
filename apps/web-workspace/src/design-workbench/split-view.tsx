import type { ReactNode } from "react";
import { Group, Panel, Separator } from "motion-panels/react";
import { MIN_SPLIT_RATIO, MAX_SPLIT_RATIO, type LayoutNode } from "./layout-model";

/** Controlled layout presentation. The model, not the panel library, owns pane identity. */
export function SplitView({
  node,
  renderPane,
  onResize,
}: {
  node: LayoutNode;
  renderPane: (id: string) => ReactNode;
  onResize: (id: string, ratio: number) => void;
}) {
  if (node.type === "pane") return renderPane(node.id);
  return (
    <Group
      key={node.id}
      orientation={node.axis}
      transition={{ duration: 0 }}
      className="dw-split"
      data-direction={node.axis}
    >
      <Panel
        className="dw-split-panel"
        size={`${node.ratio * 100}%`}
        minSize={`${MIN_SPLIT_RATIO * 100}%`}
        maxSize={`${MAX_SPLIT_RATIO * 100}%`}
        transition={{ duration: 0 }}
        onSizeChange={(size) => onResize(node.id, parseFloat(String(size)) / 100)}
      >
        <SplitView node={node.first} renderPane={renderPane} onResize={onResize} />
      </Panel>
      <Separator
        className="dw-divider"
        data-axis={node.axis}
        aria-label={`Resize ${node.axis} panes`}
      />
      <Panel className="dw-split-panel">
        <SplitView node={node.second} renderPane={renderPane} onResize={onResize} />
      </Panel>
    </Group>
  );
}
