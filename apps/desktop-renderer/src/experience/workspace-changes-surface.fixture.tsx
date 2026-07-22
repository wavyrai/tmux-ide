import { ApplicationShellProjectionInputV1SchemaZ } from "@tmux-ide/contracts";
import { render } from "solid-js/web";

import { createBrowserHostCapabilities } from "../host-capabilities.ts";
import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { DomApplicationShell } from "./application-shell.tsx";
import { createDomExperience } from "./dom-experience.ts";
import { createDefaultDomPaneFrames, createDefaultDomShellInput } from "./dom-shell.ts";
import type { ChangesSurfaceProps } from "./workspace-changes-surface.tsx";
import {
  createChangesDetachedModel,
  createChangesEmptyModel,
  createChangesNoGitModel,
  createChangesReadyModel,
  createDiffBinaryModel,
  createDiffReadyModel,
  createDiffTruncatedModel,
  createDiffUnavailableModel,
} from "./workspace-changes-fixture.ts";

export type ChangesSurfaceScenario =
  | "ready"
  | "ready-diff"
  | "truncated-diff"
  | "binary-diff"
  | "unavailable-diff"
  | "detached"
  | "empty"
  | "loading"
  | "no-git";

const base = createDefaultDomShellInput();
const paneFrames = createDefaultDomPaneFrames();

function changesSurface(scenario: ChangesSurfaceScenario): ChangesSurfaceProps {
  const callbacks = {
    onSelectChange: () => undefined,
    onRetry: () => undefined,
    onRetryDiff: () => undefined,
  };
  switch (scenario) {
    case "ready":
      return { model: createChangesReadyModel(), diff: { kind: "absent" }, ...callbacks };
    case "ready-diff":
      return { model: createChangesReadyModel(), diff: createDiffReadyModel(), ...callbacks };
    case "truncated-diff":
      return { model: createChangesDetachedModel(), diff: createDiffTruncatedModel(), ...callbacks };
    case "binary-diff":
      return { model: createChangesReadyModel(), diff: createDiffBinaryModel(), ...callbacks };
    case "unavailable-diff":
      return { model: createChangesReadyModel(), diff: createDiffUnavailableModel(), ...callbacks };
    case "detached":
      return { model: createChangesDetachedModel(), diff: { kind: "absent" }, ...callbacks };
    case "empty":
      return { model: createChangesEmptyModel(), diff: { kind: "absent" }, ...callbacks };
    case "loading":
      return { model: { kind: "loading" }, diff: { kind: "absent" }, ...callbacks };
    case "no-git":
      return { model: createChangesNoGitModel(), diff: { kind: "absent" }, ...callbacks };
  }
}

function input() {
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    ...base,
    dock: { ...base.dock, mode: "maximized", activeTool: "changes" },
  });
}

/** Full-window visual acceptance fixture for the native Changes dock body. */
export function mountWorkspaceChangesShellFixture(
  root: HTMLElement,
  scenario: ChangesSurfaceScenario = "ready-diff",
  appearance: "dark" | "light" = "dark",
): () => void {
  const experience = createDomExperience({ hostTheme: { mode: appearance } });
  let disposeStyle: (() => void) | null = null;
  const dispose = render(
    () => (
      <div
        ref={(element) => {
          const binding = createRuntimeStyleBinding(element);
          binding.update(experience.variables);
          disposeStyle = () => binding.dispose();
        }}
        class="app"
        data-theme={appearance}
        data-platform="darwin"
        data-reduced-motion="false"
        data-shell-source="workspace-changes-visual"
      >
        <DomApplicationShell
          host={createBrowserHostCapabilities()}
          runtime="browser"
          platform="darwin"
          input={input()}
          dataMode="runtime"
          paneFrames={paneFrames}
          terminalTransport={null}
          changesSurface={changesSurface(scenario)}
        />
      </div>
    ),
    root,
  );
  return () => {
    dispose();
    disposeStyle?.();
  };
}
