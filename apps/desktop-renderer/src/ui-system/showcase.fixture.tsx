import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";

import { Button } from "./button.tsx";
import { Icon } from "./icon.tsx";
import { EmptyState } from "./empty-state.tsx";
import { IconButton } from "./icon-button.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Tabs } from "./tabs.tsx";

function PlusIcon(): JSX.Element {
  return <Icon icon={PlusSignIcon} />;
}

/** Static review fixture; deliberately not wired into the production shell. */
export function UiSystemShowcaseFixture(): JSX.Element {
  const [split, setSplit] = createSignal(48);
  return (
    <div class="tmi-showcase" data-tmi-theme="dark">
      <div data-overlay-root="true">
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

/** Browser-smoke mount kept out of the application shell composition. */
export function mountUiSystemShowcaseFixture(root: HTMLElement): () => void {
  return render(() => <UiSystemShowcaseFixture />, root);
}

/** Real-browser controlled rerender probe used by the strict-CSP smoke. */
export function mountControlledTabsSmokeFixture(root: HTMLElement): {
  readonly select: (value: string) => void;
  readonly dispose: () => void;
} {
  const [value, setValue] = createSignal("canvas");
  const dispose = render(
    () => (
      <Tabs
        label="Controlled smoke views"
        value={value()}
        items={[
          { id: "canvas", label: "Canvas", panel: "Canvas panel" },
          { id: "changes", label: "Changes", panel: "Changes panel" },
        ]}
      />
    ),
    root,
  );
  return { select: setValue, dispose };
}
