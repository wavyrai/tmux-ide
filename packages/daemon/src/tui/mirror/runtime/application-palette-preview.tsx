/* @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";
import { TuiButton } from "../ui/button.tsx";
import { clipTerminal } from "../terminal-text.ts";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import { applicationMachineAuthorityManager } from "./application-machine-authority.ts";
import {
  createAdaptiveFleetPreviewOwner,
  fleetPreviewActivity,
  readFleetWindowPreview,
  type AdaptiveFleetPreviewState,
} from "./application-fleet-preview.ts";

import { fleetHostColor } from "./fleet-presentation.ts";

/** F5 browsing is passive and pinned to the highlighted command's exact authority. */
export function ApplicationPalettePreview(props: {
  command: ApplicationPaletteCommand | undefined;
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  active: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [hidden, setHidden] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [windowId, setWindowId] = createSignal<string | undefined>();
  const [revision, setRevision] = createSignal(0);
  const [state, setState] = createSignal<AdaptiveFleetPreviewState>({
    status: "idle",
    snapshot: null,
    stale: false,
  });
  const owner = createAdaptiveFleetPreviewOwner(setState);
  const stop = applicationMachineAuthorityManager.subscribe(() => setRevision((v) => v + 1));
  const command = () => (typeof props.command === "object" ? props.command : undefined);
  const target = () => command()?.fleet;
  const identity = () =>
    JSON.stringify([target()?.machineId, target()?.liveSessionId, target()?.daemonInstanceId]);
  let previousIdentity = "";
  createEffect(() => {
    const next = identity();
    if (next !== previousIdentity) {
      previousIdentity = next;
      setWindowId(undefined);
    }
  });
  createEffect(() => {
    revision();
    const fleet = target();
    const handle = fleet ? applicationMachineAuthorityManager.getMachine(fleet.machineId) : null;
    const selected = windowId();
    const usable =
      props.active &&
      !hidden() &&
      props.height >= 4 &&
      fleet &&
      Boolean(fleet.liveSessionId) &&
      !fleet.disabled &&
      handle?.endpoint().state === "ready" &&
      handle.read()?.instanceId === fleet.daemonInstanceId;
    owner.select(
      usable
        ? (signal) => readFleetWindowPreview(handle, fleet.liveSessionId, signal, selected)
        : undefined,
      JSON.stringify([identity(), handle?.endpoint().epoch, selected]),
    );
  });
  onCleanup(() => {
    stop();
    owner.dispose();
  });
  const cycle = (direction: number) => {
    const snapshot = state().snapshot;
    const windows = snapshot?.windows ?? [];
    if (!windows.length) return;
    const index = Math.max(
      0,
      windows.findIndex((w) => w.id === snapshot?.selectedWindowId),
    );
    setWindowId(windows[(index + direction + windows.length) % windows.length]?.id);
  };
  const toggleExpanded = () => {
    const next = !expanded();
    setExpanded(next);
    props.onExpandedChange?.(next);
  };
  const toggleHidden = () => {
    const next = !hidden();
    setHidden(next);
    if (next && expanded()) {
      setExpanded(false);
      props.onExpandedChange?.(false);
    }
  };
  useKeyboardRoute((event) => {
    if (!props.active || !event.ctrl || event.meta) return false;
    const key = event.name.toLowerCase();
    if (!["left", "right", "p", "e"].includes(key)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.eventType !== "press") return true;
    if (key === "p") toggleHidden();
    else if (key === "e" && !hidden()) toggleExpanded();
    else if (!hidden()) cycle(key === "left" ? -1 : 1);
    return true;
  });
  const heading = () => {
    const snapshot = state().snapshot;
    const window = snapshot?.windows.find((w) => w.id === snapshot.selectedWindowId);
    return `${target()?.hostLabel ?? "Session preview"} · ${command()?.sessionName ?? "Select a session"}${window ? ` · ${window.index}: ${window.name}` : ""}`;
  };
  const hostColor = () => {
    revision();
    const fleet = target();
    return fleet
      ? fleetHostColor({
          id: fleet.machineId,
          environmentId: applicationMachineAuthorityManager.getMachine(fleet.machineId)?.read()
            ?.environmentId,
        })
      : props.theme.roles.text.muted;
  };
  const activity = () => {
    const snapshot = state().snapshot;
    const window = snapshot?.windows.find((w) => w.id === snapshot.selectedWindowId);
    return fleetPreviewActivity(window?.paneIds, target()?.agentActivities);
  };
  const width = () => Math.max(1, props.width);
  return (
    <box
      width={width()}
      height={Math.max(1, props.height)}
      flexDirection="column"
      overflow="hidden"
    >
      <text height={1} fg={hostColor()} content={clipTerminal(heading(), width())} />
      <box height={1} flexDirection="row" gap={1}>
        <TuiButton
          theme={props.theme}
          label="‹"
          size="compact"
          disabled={!props.active || hidden() || !state().snapshot?.windows.length}
          onPress={() => cycle(-1)}
        />
        <TuiButton
          theme={props.theme}
          label="›"
          size="compact"
          disabled={!props.active || hidden() || !state().snapshot?.windows.length}
          onPress={() => cycle(1)}
        />
        <TuiButton
          theme={props.theme}
          label={hidden() ? "Show" : "Hide"}
          size="compact"
          disabled={!props.active}
          onPress={toggleHidden}
        />
        <Show when={width() >= 27}>
          <TuiButton
            theme={props.theme}
            label={expanded() ? "Restore" : "Expand"}
            size="compact"
            disabled={!props.active || hidden()}
            onPress={toggleExpanded}
          />
        </Show>
      </box>
      <Show
        when={!hidden()}
        fallback={
          <text height={1} fg={props.theme.roles.text.muted}>
            Preview hidden
          </text>
        }
      >
        <text
          height={1}
          fg={props.theme.roles.text.muted}
          content={clipTerminal(
            state().stale
              ? "Read-only · stale · retrying"
              : state().status === "ready"
                ? `Read-only · ${activity()}`
                : state().status === "loading"
                  ? "Loading preview…"
                  : target()?.liveSessionId
                    ? "Preview unavailable"
                    : "Select a session to preview",
            width(),
          )}
        />
        <text
          height={Math.max(1, props.height - 3)}
          fg={props.theme.roles.text.primary}
          content={(state().snapshot?.text ?? "")
            .split("\n")
            .slice(-Math.max(1, props.height - 3))
            .map((line) => clipTerminal(line, width()))
            .join("\n")}
        />
      </Show>
    </box>
  );
}
