/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";

import { OverlayHost, type OverlayLayer } from "../ui/overlay-host.tsx";

export type ApplicationOverlayIntent = Readonly<{
  type: "overlay.dismiss";
  id: string;
}>;

export interface ApplicationShellOverlayStackProps {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly OverlayLayer[];
  readonly focusedOwner: string;
  readonly isFocusMounted: (id: string) => boolean;
  readonly restoreFocus: (id: string) => void;
  readonly onIntent: (intent: ApplicationOverlayIntent) => void;
}

/** Shared catalog/connected overlay host with one focus-restoration contract. */
export function ApplicationShellOverlayStack(
  props: ApplicationShellOverlayStackProps,
): JSX.Element {
  return (
    <OverlayHost
      width={props.width}
      height={props.height}
      layers={props.layers}
      ownsEscape={false}
      captureFocus={() => props.focusedOwner}
      isFocusMounted={props.isFocusMounted}
      restoreFocus={props.restoreFocus}
      onDismiss={(id) => props.onIntent({ type: "overlay.dismiss", id })}
    />
  );
}
