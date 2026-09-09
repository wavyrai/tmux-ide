import type { InteractionReceipt } from "@tmux-ide/contracts";
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import {
  INTERACTION_PRESENCE_MS,
  initialInteractionFeedState,
  interactionPresenceIsFresh,
  reduceInteractionReceipt,
  type PaneInteractionProjection,
} from "@tmux-ide/core";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

export type ApplicationPaneActivity = Accessor<ReadonlyMap<string, PaneInteractionProjection>> & {
  readonly activity: Accessor<readonly InteractionReceipt[]>;
};

/** Receipt presence shares the existing client subscription, never a polling connection. */
export function createApplicationPaneActivityOwner(
  generation: Accessor<OpenTuiGenerationHostSnapshot | null>,
): ApplicationPaneActivity {
  const [panes, setPanes] = createSignal<ReadonlyMap<string, PaneInteractionProjection>>(new Map());
  const [activity, setActivity] = createSignal<readonly InteractionReceipt[]>([]);
  const clientOwner = createMemo(() => {
    const host = generation();
    return host?.status === "live" ? host.client : null;
  });
  createEffect(() => {
    const client = clientOwner();
    setPanes(new Map());
    setActivity([]);
    if (!client) return;
    let clientGeneration = client.getSnapshot().generation;
    let feed = initialInteractionFeedState();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const now = Date.now();
      const entries = Object.entries(feed.panes)
        .filter(([, value]) => interactionPresenceIsFresh(value, now))
        .slice(-128);
      feed = { ...feed, panes: Object.fromEntries(entries) };
      setPanes(new Map(entries));
      setActivity(
        feed.activity.filter(
          (receipt) =>
            receipt.operationKind === "workspace.pane.read" ||
            receipt.operationKind === "workspace.pane.send",
        ),
      );
      if (entries.length) {
        const deadline = Math.min(
          ...entries.map(([, value]) => Date.parse(value.at) + INTERACTION_PRESENCE_MS),
        );
        timer = setTimeout(publish, Math.max(1, deadline - now + 1));
      }
    };
    const update = () => {
      const snapshot = client.getSnapshot();
      if (snapshot.generation !== clientGeneration) {
        clientGeneration = snapshot.generation;
        feed = initialInteractionFeedState();
        publish();
      }
      const receipt = snapshot.operations.lastObservedReceipt;
      if (!receipt || receipt.sequence <= feed.sequence) return;
      feed = reduceInteractionReceipt(feed, receipt);
      publish();
    };
    const stop = client.subscribe("operations", update);
    const stopLifecycle = client.subscribe("lifecycle", update);
    update();
    onCleanup(() => {
      stop();
      stopLifecycle();
      if (timer !== null) clearTimeout(timer);
    });
  });
  return Object.assign(panes, { activity });
}
