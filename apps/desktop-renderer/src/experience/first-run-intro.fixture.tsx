import { render } from "solid-js/web";

import { createRuntimeStyleBinding } from "../runtime-style.ts";
import { createDomExperience } from "./dom-experience.ts";
import { FirstRunIntro } from "./first-run-intro.tsx";

/** Full-window visual/CSP fixture for the first-run intro layer. */
export function mountFirstRunIntroFixture(
  root: HTMLElement,
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
        data-shell-source="visual-smoke"
      >
        <FirstRunIntro platform="darwin" onDismiss={() => undefined} />
      </div>
    ),
    root,
  );
  return () => {
    dispose();
    disposeStyle?.();
  };
}
