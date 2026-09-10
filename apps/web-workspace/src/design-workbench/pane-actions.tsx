import type { RefObject } from "react";
import { Menu } from "@base-ui/react/menu";
import { Columns2, Rows2, X } from "../icons";
export function PaneActions({
  portal,
  title,
  zoomed,
  targets,
  onSplit,
  onZoom,
  onClose,
  onSwap,
}: {
  portal: RefObject<HTMLDivElement | null>;
  title: string;
  zoomed: boolean;
  targets: { id: string; title: string }[];
  onSplit: (edge: "right" | "bottom") => void;
  onZoom: () => void;
  onClose: () => void;
  onSwap: (id: string) => void;
}) {
  return (
    <div className="dw-pane-actions">
      <button
        className="dw-button"
        aria-label={`${zoomed ? "Restore" : "Zoom"} ${title}`}
        onClick={onZoom}
      >
        {zoomed ? "Restore" : "Zoom"}
      </button>
      <Menu.Root>
        <Menu.Trigger className="dw-button" aria-label={`Actions for ${title}`}>
          ···
        </Menu.Trigger>
        <Menu.Portal container={portal}>
          <Menu.Positioner sideOffset={0} align="end">
            <Menu.Popup className="dw-action-menu">
              <Menu.Item className="dw-menu-item" onClick={() => onSplit("right")}>
                <Columns2 size={14} />
                Split right
              </Menu.Item>
              <Menu.Item className="dw-menu-item" onClick={() => onSplit("bottom")}>
                <Rows2 size={14} />
                Split down
              </Menu.Item>
              {targets.map((target) => (
                <Menu.Item
                  className="dw-menu-item"
                  key={target.id}
                  onClick={() => onSwap(target.id)}
                >
                  Swap with {target.title}
                </Menu.Item>
              ))}
              <Menu.Item className="dw-menu-item" onClick={onClose}>
                <X size={14} />
                Close pane
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
