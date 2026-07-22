import { render } from "solid-js/web";

import { createDomExperience } from "./dom-experience.ts";
import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { AppWindowCanvas } from "./app-window-canvas.tsx";
import {
  agentGraphCanvasDocument,
  agentGraphCanvasInventory,
  agentGraphCanvasOverlay,
  agentGraphCanvasPaneFrames,
  type AgentGraphCanvasScenario,
} from "./agent-graph-canvas-fixture.ts";

/**
 * Full-canvas visual acceptance fixture for the agent-graph overlay. Mounts the
 * canvas directly (the overlay is a canvas-level seam, not yet wired through the
 * application shell) inside a themed `.app` host so the design tokens resolve.
 */
export function mountAgentGraphCanvasFixture(
  root: HTMLElement,
  scenario: AgentGraphCanvasScenario = "mission-group",
  appearance: "dark" | "light" = "dark",
  reducedMotion = false,
): () => void {
  const experience = createDomExperience({ hostTheme: { mode: appearance } });
  const document = agentGraphCanvasDocument();
  const paneFrames = agentGraphCanvasPaneFrames();
  const inventory = agentGraphCanvasInventory();
  const overlay = agentGraphCanvasOverlay(scenario);
  let disposeStyle: (() => void) | null = null;
  const dispose = render(
    () => (
      <div
        ref={(element) => {
          const binding = createRuntimeStyleBinding(element);
          binding.update({ ...experience.variables, height: "100vh" });
          disposeStyle = () => binding.dispose();
        }}
        class="app terminal-canvas"
        data-theme={appearance}
        data-platform="darwin"
        data-reduced-motion={String(reducedMotion)}
        data-shell-source="agent-graph-canvas-visual"
      >
        <AppWindowCanvas
          document={document}
          paneFrames={paneFrames}
          terminalInventory={inventory}
          workspaceName="agent-graph-visual"
          reducedMotion={reducedMotion}
          overlay={overlay}
          onCommand={() => undefined}
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
