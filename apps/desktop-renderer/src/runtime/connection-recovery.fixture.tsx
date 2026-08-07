import { render } from "solid-js/web";

import { createDomExperience } from "../experience/dom-experience.ts";
import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { DesktopConnectionSurface } from "./live-app-composition.tsx";
import { recoveryForDaemonCapability } from "./connection-recovery.ts";

/** Full-window visual/CSP fixture for a recovery state with a copyable command. */
export function mountConnectionRecoveryFixture(
  root: HTMLElement,
  appearance: "dark" | "light" = "dark",
): () => void {
  const experience = createDomExperience({ hostTheme: { mode: appearance } });
  const recovery = recoveryForDaemonCapability(
    { status: "unavailable", code: "probe-failed", reason: "spawn tmux ENOENT" },
    "darwin",
  );
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
        data-shell-source="visual-smoke"
      >
        <DesktopConnectionSurface
          runtime="electron"
          platform="darwin"
          state="degraded"
          eyebrow={recovery.eyebrow}
          title={recovery.title}
          description={recovery.description}
          guidance={recovery.guidance}
          command={recovery.command}
          onRetry={() => undefined}
          retryLabel="Recheck daemon"
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
