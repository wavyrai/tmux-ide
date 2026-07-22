import { createSignal, type JSX } from "solid-js";

import { Button } from "./button.tsx";
import { EmptyState } from "./empty-state.tsx";
import { IconButton } from "./icon-button.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Tabs } from "./tabs.tsx";

function PlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-linecap="round" />
    </svg>
  );
}

/** Static review fixture; deliberately not wired into the production shell. */
export function UiSystemShowcaseFixture(): JSX.Element {
  const [split, setSplit] = createSignal(48);
  return (
    <div class="tmi-showcase" data-tmi-theme="dark">
      <div>
        <Button variant="primary">New terminal</Button>
        <Button>Reconnect</Button>
        <Button variant="ghost">Cancel</Button>
        <Button loading>Connecting</Button>
        <IconButton label="Add pane" pressed>
          <PlusIcon />
        </IconButton>
      </div>
      <Tabs
        label="Terminal details"
        items={[
          { id: "output", label: "Output", panel: <span class="tmi-technical">build ready</span> },
          { id: "ports", label: "Ports", panel: <span class="tmi-technical">localhost:4000</span> },
        ]}
      />
      <div class="tmi-showcase__split" data-value={split()}>
        <div>Canvas</div>
        <ResizeHandle value={split()} min={20} max={80} onValueChange={setSplit} />
        <div>Inspector</div>
      </div>
      <EmptyState
        title="No terminal selected"
        description="Choose a running pane or create a new terminal."
        action={<Button size="small">Create terminal</Button>}
      />
    </div>
  );
}
