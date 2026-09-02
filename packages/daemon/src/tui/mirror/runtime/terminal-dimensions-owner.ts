import type { CliRenderer } from "@opentui/core";
import { render, useTerminalDimensions } from "@opentui/solid";
import { createComponent, type Accessor, type JSX } from "solid-js";

import type { HostedTtySize } from "./hosted-tty-size-bridge.ts";

interface TerminalDimensionsOwnerProps {
  readonly mount: (dimensions: Accessor<HostedTtySize>) => JSX.Element;
}

function TerminalDimensionsOwner(props: TerminalDimensionsOwnerProps): JSX.Element {
  return props.mount(useTerminalDimensions());
}

/** Mount the root callback inside a component so OpenTUI owns hook cleanup. */
export function renderWithTerminalDimensions(
  renderer: CliRenderer,
): (mount: TerminalDimensionsOwnerProps["mount"]) => Promise<void> {
  return (mount) => render(() => createComponent(TerminalDimensionsOwner, { mount }), renderer);
}
