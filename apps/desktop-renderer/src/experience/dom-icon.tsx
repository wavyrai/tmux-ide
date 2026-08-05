import type { SemanticIconId } from "@tmux-ide/contracts";

import { Icon } from "../ui-system/icon.tsx";
import { resolveDomIcon, type DomIconUsage } from "./dom-icons.ts";

export interface DomIconProps {
  readonly id: SemanticIconId;
  readonly usage?: DomIconUsage;
  readonly label?: string;
  readonly class?: string;
}

/**
 * A semantic icon, addressed by product vocabulary.
 *
 * This is the named layer over the generic `Icon`: surfaces ask for `changes`
 * or `pop-out` and get whatever artwork the system currently binds to that id,
 * at the size its usage calls for.
 */
export function DomIcon(props: DomIconProps) {
  const icon = () => resolveDomIcon(props.id, props.usage);
  return (
    <Icon
      icon={icon().artwork}
      size={icon().size}
      strokeWidth={icon().strokeWidth}
      label={props.label}
      class={props.class}
    />
  );
}
