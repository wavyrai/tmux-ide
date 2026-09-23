/* @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { TuiButton } from "../ui/button.tsx";
import { clipTerminal } from "../terminal-text.ts";
import {
  GUIDED_TOUR_STEPS,
  guidedTourCopy,
  type GuidedTourState,
  type GuidedTourShortcuts,
} from "./guided-tour.ts";

export interface GuidedTourCoachProps {
  readonly state: GuidedTourState;
  readonly theme: SemanticThemeSnapshot;
  readonly width: number;
  readonly height?: number;
  readonly shortcuts?: GuidedTourShortcuts;
  readonly error?: string | null;
  readonly busy?: boolean;
  readonly onReplay?: () => void;
  readonly onPause: () => void;
  readonly onWelcomeRead: () => void;
  readonly onCreatePractice: () => void;
  readonly onOpenCommands: () => void;
  readonly onOpenAppearance: () => void;
  readonly onOpenHome: () => void;
  readonly onOpenPractice: () => void;
}
/** Non-modal coach: terminal interaction stays available throughout the tour. */
export function GuidedTourCoach(props: GuidedTourCoachProps) {
  const copy = () => guidedTourCopy(props.state.step, props.shortcuts);
  const width = () => Math.max(1, props.width);
  const primary = () => {
    switch (props.state.step) {
      case "welcome":
        return { label: "Let's try it", run: props.onWelcomeRead };
      case "practice":
        return { label: "Create practice session", run: props.onCreatePractice };
      case "split":
      case "commands":
        return { label: "Open commands", run: props.onOpenCommands };
      case "theme":
        return { label: "Choose theme", run: props.onOpenAppearance };
      case "leave":
        return { label: "Open Home", run: props.onOpenHome };
      case "reopen":
        return { label: "Reopen practice", run: props.onOpenPractice };
      default:
        return null;
    }
  };
  return (
    <box
      id="guided-tour-coach"
      width={width()}
      height={props.height ?? 10}
      overflow="hidden"
      flexShrink={0}
      flexDirection="column"
      paddingX={1}
      backgroundColor={props.theme.roles.surfaces.panel}
    >
      <text height={1} fg={props.theme.roles.text.primary}>
        <strong>
          {clipTerminal(
            `Learn tmux-ide · ${GUIDED_TOUR_STEPS.indexOf(props.state.step) + 1}/${GUIDED_TOUR_STEPS.length} · ${copy().title}`,
            Math.max(0, width() - 2),
          )}
        </strong>
      </text>
      <scrollbox flexGrow={1} width="100%">
        <text fg={props.theme.roles.text.secondary}>{copy().body}</text>
      </scrollbox>
      <Show when={props.error}>
        <text fg={props.theme.roles.text.primary}>{props.error}</text>
      </Show>
      <box flexDirection="row" flexWrap="wrap" flexShrink={0} gap={1}>
        <Show
          when={props.state.practice && ["split", "focus", "resize"].includes(props.state.step)}
        >
          <TuiButton
            theme={props.theme}
            label="Open practice"
            onPress={props.onOpenPractice}
            width={Math.min(Math.max(1, width() - 2), 17)}
          />
        </Show>
        <Show when={props.onReplay && props.error}>
          <TuiButton
            theme={props.theme}
            label="Restart tour"
            onPress={props.onReplay}
            width={Math.min(Math.max(1, width() - 2), 16)}
          />
        </Show>
        <Show when={primary()}>
          {(action) => (
            <TuiButton
              theme={props.theme}
              label={action().label}
              width={Math.min(Math.max(1, width() - 2), action().label.length + 4)}
              loading={props.busy}
              onPress={action().run}
            />
          )}
        </Show>
        <TuiButton
          theme={props.theme}
          label={props.state.step === "complete" ? "Done" : "Pause tour"}
          width={Math.min(Math.max(1, width() - 2), 14)}
          variant="ghost"
          onPress={props.onPause}
        />
      </box>
    </box>
  );
}
