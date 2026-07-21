import { For } from "solid-js";
import type { SemanticIconId } from "@tmux-ide/contracts";

import { resolveDomIcon, type DomIconUsage } from "./dom-icons.ts";

export interface DomIconProps {
  readonly id: SemanticIconId;
  readonly usage?: DomIconUsage;
  readonly label?: string;
  readonly class?: string;
}

/** Canonical, currentColor SVG leaf shared by every DOM shell surface. */
export function DomIcon(props: DomIconProps) {
  const icon = () => resolveDomIcon(props.id, props.usage);
  return (
    <svg
      class={props.class}
      width={icon().size}
      height={icon().size}
      viewBox={icon().viewBox}
      fill={icon().fill}
      stroke={icon().stroke}
      stroke-width={icon().strokeWidth}
      stroke-linecap={icon().strokeLinecap}
      stroke-linejoin={icon().strokeLinejoin}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <For each={icon().paths}>{(path) => <path d={path} />}</For>
    </svg>
  );
}
