/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { Button } from "../ui/button.tsx";
import type { ApplicationTerminalAgentIndicator } from "./application-terminal-workspace-policy.ts";

export type ApplicationHomeBrandVariant = "full" | "compact" | "wordmark";

const APPLICATION_HOME_FULL_LOGO = `   ░██                                             ░██       ░██
   ░██                                                       ░██
░████████ ░█████████████  ░██    ░██ ░██    ░██    ░██ ░████████  ░███████
   ░██    ░██   ░██   ░██ ░██    ░██  ░██  ░██     ░██░██    ░██ ░██    ░██
   ░██    ░██   ░██   ░██ ░██    ░██   ░█████      ░██░██    ░██ ░█████████
   ░██    ░██   ░██   ░██ ░██   ░███  ░██  ░██     ░██░██   ░███ ░██
    ░████ ░██   ░██   ░██  ░█████░██ ░██    ░██    ░██ ░█████░██  ░███████`;

const APPLICATION_HOME_COMPACT_LOGO = [
  "▀█▀ █▄█ █ █ ▀▄▀ ─ █ █▀▄ █▀▀",
  " █  █ █ █▄█ █ █   █ █▄▀ ██▄",
] as const;
const APPLICATION_HOME_FULL_LOGO_WIDTH = 76;
const APPLICATION_HOME_COMPACT_LOGO_WIDTH = 29;

export function applicationHomeBrandVariant(
  width: number,
  height: number,
): ApplicationHomeBrandVariant {
  if (width >= 76 && height >= 23) return "full";
  if (width >= 36 && height >= 13) return "compact";
  return "wordmark";
}

export function ApplicationHomeSurface(props: {
  readonly project: string;
  readonly status: string;
  readonly note: string | null;
  readonly width: number;
  readonly height: number;
  readonly sessionCount: number;
  readonly session?: string | null;
  readonly agents?: readonly ApplicationTerminalAgentIndicator[];
  readonly branded: boolean;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onOpenTerminals: () => void;
  readonly onOpenCommands: () => void;
  readonly onCycleTheme?: () => void;
}): JSX.Element {
  const working = () => props.agents?.filter((agent) => agent.activity === "running").length ?? 0;
  const attention = () => props.agents?.filter((agent) => agent.attention).length ?? 0;
  const variant = () => applicationHomeBrandVariant(props.width, props.height);
  const brandLines = () =>
    variant() === "full"
      ? APPLICATION_HOME_FULL_LOGO.split("\n").map((line) => line.trimEnd())
      : variant() === "compact"
        ? [...APPLICATION_HOME_COMPACT_LOGO]
        : ["tmux-ide"];
  const brandWidth = () =>
    variant() === "full"
      ? APPLICATION_HOME_FULL_LOGO_WIDTH
      : variant() === "compact"
        ? APPLICATION_HOME_COMPACT_LOGO_WIDTH
        : 8;
  const availableWidth = () => Math.max(1, props.width - (props.width >= 8 ? 4 : 0));
  const tagline = () =>
    clipTerminal(
      variant() === "full"
        ? "Your tmux sessions, panes, and coding agents — one resilient workspace."
        : "Your tmux sessions and agents, in one place.",
      availableWidth(),
    );
  const summary = () =>
    clipTerminal(
      `${props.sessionCount} ${props.sessionCount === 1 ? "session" : "sessions"} · ${working()} working · ${attention()} need attention`,
      availableWidth(),
    );
  const context = () =>
    clipTerminal(`${props.session ?? "No session selected"} · ${props.status}`, availableWidth());
  const note = () => (props.note ? clipTerminal(props.note, availableWidth()) : null);
  const actionsInRow = () => props.width >= 42;

  if (!props.branded) {
    return (
      <box
        width={props.width}
        height={props.height}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        gap={1}
        overflow="hidden"
      >
        <text fg={props.theme.roles.text.primary}>
          <strong>{clipTerminal(props.project, availableWidth())}</strong>
        </text>
        <text fg={props.theme.roles.text.muted}>{context()}</text>
        <For each={note() ? [note()!] : []}>
          {(message) => <text fg={props.theme.roles.text.link}>{message}</text>}
        </For>
      </box>
    );
  }

  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={variant() === "wordmark" ? 0 : 1}
      overflow="hidden"
    >
      <box width={brandWidth()} flexDirection="column">
        <For each={brandLines()}>
          {(line) => (
            <text width={brandWidth()} fg={props.theme.roles.text.link}>
              {line}
            </text>
          )}
        </For>
      </box>
      <For each={variant() !== "wordmark" ? [true] : []}>
        {() => <text fg={props.theme.roles.text.secondary}>{tagline()}</text>}
      </For>
      <text fg={props.theme.roles.text.primary}>
        <strong>{summary()}</strong>
      </text>
      <text fg={props.theme.roles.text.muted}>{context()}</text>
      <box
        flexDirection={actionsInRow() ? "row" : "column"}
        alignItems="center"
        gap={actionsInRow() ? 2 : 0}
      >
        <Button
          theme={props.theme}
          label="Open terminals"
          shortcut="F2"
          variant="primary"
          onPress={props.onOpenTerminals}
        />
        <Button theme={props.theme} label="Commands" shortcut="F5" onPress={props.onOpenCommands} />
        <For each={props.onCycleTheme ? [props.onCycleTheme] : []}>
          {(onCycleTheme) => (
            <Button
              theme={props.theme}
              label={`Theme: ${props.theme.setting}`}
              variant="ghost"
              onPress={onCycleTheme}
            />
          )}
        </For>
      </box>
      <For each={note() ? [note()!] : []}>
        {(message) => <text fg={props.theme.roles.text.link}>{message}</text>}
      </For>
    </box>
  );
}
