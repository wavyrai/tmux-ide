import { ApplicationShellProjectionInputV1SchemaZ } from "@tmux-ide/contracts";
import { render } from "solid-js/web";

import { createBrowserHostCapabilities } from "../host-capabilities.ts";
import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { DomApplicationShell } from "./application-shell.tsx";
import { createDomExperience } from "./dom-experience.ts";
import { createDefaultDomPaneFrames, createDefaultDomShellInput } from "./dom-shell.ts";
import type { FilesSurfaceProps } from "./workspace-files-surface.tsx";
import {
  createFilesEmptyModel,
  createFilesPreviewBinary,
  createFilesPreviewReady,
  createFilesPreviewTruncated,
  createFilesPreviewUnavailable,
  createFilesReadyModel,
  createFilesTruncatedModel,
  createFilesUnavailableModel,
} from "./workspace-files-fixture.ts";

export type FilesSurfaceScenario =
  | "ready"
  | "ready-preview"
  | "truncated"
  | "binary-preview"
  | "unavailable-preview"
  | "empty"
  | "loading"
  | "unavailable";

const base = createDefaultDomShellInput();
const paneFrames = createDefaultDomPaneFrames();

function filesSurface(scenario: FilesSurfaceScenario): FilesSurfaceProps {
  const callbacks = {
    onSelectFile: () => undefined,
    onToggleDirectory: () => undefined,
    onRetry: () => undefined,
    onRetryPreview: () => undefined,
  };
  switch (scenario) {
    case "ready":
      return { model: createFilesReadyModel(), preview: { kind: "absent" }, ...callbacks };
    case "ready-preview":
      return { model: createFilesReadyModel(), preview: createFilesPreviewReady(), ...callbacks };
    case "truncated":
      return {
        model: createFilesTruncatedModel(),
        preview: createFilesPreviewTruncated(),
        ...callbacks,
      };
    case "binary-preview":
      return { model: createFilesReadyModel(), preview: createFilesPreviewBinary(), ...callbacks };
    case "unavailable-preview":
      return {
        model: createFilesReadyModel(),
        preview: createFilesPreviewUnavailable(),
        ...callbacks,
      };
    case "empty":
      return { model: createFilesEmptyModel(), preview: { kind: "absent" }, ...callbacks };
    case "loading":
      return { model: { kind: "loading" }, preview: { kind: "absent" }, ...callbacks };
    case "unavailable":
      return { model: createFilesUnavailableModel(), preview: { kind: "absent" }, ...callbacks };
  }
}

function input() {
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    ...base,
    dock: { ...base.dock, mode: "maximized", activeTool: "files" },
  });
}

/** Full-window visual acceptance fixture for the native Files dock body. */
export function mountWorkspaceFilesShellFixture(
  root: HTMLElement,
  scenario: FilesSurfaceScenario = "ready-preview",
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
        data-shell-source="workspace-files-visual"
      >
        <DomApplicationShell
          host={createBrowserHostCapabilities()}
          runtime="browser"
          platform="darwin"
          input={input()}
          dataMode="runtime"
          paneFrames={paneFrames}
          terminalTransport={null}
          filesSurface={filesSurface(scenario)}
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
