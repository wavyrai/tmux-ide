import type { ComponentProps } from "react";

export function Pane({ className = "", ...props }: ComponentProps<"div">) {
  return <div data-slot="pane" className={`live-pane ${className}`} {...props} />;
}
export function PaneHeader({ className = "", ...props }: ComponentProps<"header">) {
  return <header data-slot="pane-header" className={`live-pane-header ${className}`} {...props} />;
}
export function PaneTitle({ className = "", ...props }: ComponentProps<"button">) {
  return <button data-slot="pane-title" className={`live-pane-title ${className}`} {...props} />;
}
export function PaneAction({ className = "", ...props }: ComponentProps<"button">) {
  return <button data-slot="pane-action" className={`live-pane-action ${className}`} {...props} />;
}
