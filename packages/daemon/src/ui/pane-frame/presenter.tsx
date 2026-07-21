import {
  For,
  createComputed,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
  type JSX,
  type ParentProps,
} from "solid-js";
import type {
  CommandId,
  PaneAppearance,
  PaneRoleId,
  SemanticIconId,
  SemanticProductId,
} from "@tmux-ide/contracts";

export interface PaneFramePane {
  readonly id: SemanticProductId;
  readonly kind: PaneRoleId;
}

export interface PaneFrameStatus {
  readonly id: SemanticProductId;
  readonly label: string;
  readonly description?: string;
  readonly tone: PaneAppearance["status"]["tone"];
  readonly busy: boolean;
}

export type PaneFrameChipKind = "agent" | "attention" | "context" | "mode" | "state";

export interface PaneFrameChip {
  readonly id: SemanticProductId;
  readonly kind: PaneFrameChipKind;
  readonly label: string;
  readonly description?: string;
  readonly tone: PaneAppearance["status"]["tone"] | null;
}

export interface PaneFrameAction {
  readonly id: SemanticProductId;
  readonly commandId: CommandId;
  /** Interaction semantics are explicit; hosts must not infer these from ids or labels. */
  readonly behavior: "action" | "toggle";
  readonly icon: SemanticIconId;
  readonly label: string;
  readonly description?: string;
  readonly available: boolean;
  readonly disabledReason: string | null;
  readonly pressed: boolean;
  readonly busy: boolean;
  /** Semantic attention belongs to the action, never to transient DOM focus. */
  readonly attention?: boolean;
}

export interface PaneFrameModel {
  readonly pane: PaneFramePane;
  readonly appearance: PaneAppearance;
  readonly title: string;
  readonly subtitle: string | null;
  readonly status: PaneFrameStatus | null;
  readonly chips: readonly PaneFrameChip[];
  readonly actions: readonly PaneFrameAction[];
}

export type PaneFrameStatusItem =
  | {
      readonly kind: "status";
      readonly id: SemanticProductId;
      readonly status: PaneFrameStatus;
    }
  | {
      readonly kind: "chip";
      readonly id: SemanticProductId;
      readonly chip: PaneFrameChip;
    };

export interface PaneFrameActionIntent {
  readonly kind: "action";
  readonly paneId: SemanticProductId;
  readonly actionId: SemanticProductId;
  readonly commandId: CommandId;
}

export interface PaneFrameGripIntent {
  readonly kind: "grip";
  readonly paneId: SemanticProductId;
}

export type PaneFrameActivationSource = "keyboard" | "mouse";

export interface PaneFrameLeafContext {
  readonly pane: PaneFramePane;
  readonly appearance: PaneAppearance;
}

export type PaneFrameRootLeafProps = ParentProps<PaneFrameLeafContext>;
export type PaneFrameHeaderLeafProps = ParentProps<PaneFrameLeafContext>;

export interface PaneFrameGripLeafProps extends PaneFrameLeafContext {
  readonly onActivate?: (source: PaneFrameActivationSource) => void;
}

export interface PaneFrameTitleLeafProps extends PaneFrameLeafContext {
  readonly title: string;
  readonly subtitle: string | null;
}

export interface PaneFrameStatusLeafProps extends PaneFrameLeafContext {
  readonly item: PaneFrameStatusItem;
}

export type PaneFrameActionListLeafProps = ParentProps<
  PaneFrameLeafContext & {
    readonly actions: readonly PaneFrameAction[];
  }
>;

export interface PaneFrameActionLeafProps extends PaneFrameLeafContext {
  readonly action: PaneFrameAction;
  readonly interactive: boolean;
  readonly onActivate?: (source: PaneFrameActivationSource) => void;
}

export type PaneFrameBodyLeafProps = ParentProps<PaneFrameLeafContext>;

/** Every rendered primitive is supplied by the owning host. */
export interface PaneFrameHostLeaves {
  readonly Root: Component<PaneFrameRootLeafProps>;
  readonly Header: Component<PaneFrameHeaderLeafProps>;
  readonly Grip: Component<PaneFrameGripLeafProps>;
  readonly Title: Component<PaneFrameTitleLeafProps>;
  readonly Status: Component<PaneFrameStatusLeafProps>;
  readonly ActionList: Component<PaneFrameActionListLeafProps>;
  readonly Action: Component<PaneFrameActionLeafProps>;
  readonly Body: Component<PaneFrameBodyLeafProps>;
}

export interface PaneFramePresenterProps {
  readonly model: PaneFrameModel;
  readonly host: PaneFrameHostLeaves;
  readonly body?: JSX.Element;
  readonly onActionActivate?: (
    intent: PaneFrameActionIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly onGripActivate?: (
    intent: PaneFrameGripIntent,
    source: PaneFrameActivationSource,
  ) => void;
}

interface KeyedRecord<T> {
  readonly key: string;
  readonly value: Accessor<T>;
  readonly update: (next: T) => void;
}

function createKeyedRecords<T>(
  source: Accessor<readonly T[]>,
  keyOf: (item: T) => string,
): Accessor<readonly KeyedRecord<T>[]> {
  const [records, setRecords] = createSignal<readonly KeyedRecord<T>[]>([]);
  let available = new Map<string, KeyedRecord<T>>();

  createComputed(() => {
    const seen = new Set<string>();
    const ordered: KeyedRecord<T>[] = [];

    for (const item of source()) {
      const key = keyOf(item);
      if (seen.has(key)) throw new Error(`PaneFrame semantic identity must be unique: ${key}`);
      seen.add(key);

      const current = available.get(key);
      if (current) {
        current.update(item);
        ordered.push(current);
        continue;
      }

      const [value, setValue] = createSignal(item, { equals: false });
      ordered.push({
        key,
        value,
        update: (next) => setValue(() => next),
      });
    }

    available = new Map(ordered.map((record) => [record.key, record]));
    setRecords(ordered);
  });
  onCleanup(() => available.clear());
  return records;
}

function statusItems(model: PaneFrameModel): readonly PaneFrameStatusItem[] {
  const items: PaneFrameStatusItem[] = [];
  if (model.status) {
    items.push({ kind: "status", id: model.status.id, status: model.status });
  }
  for (const chip of model.chips) items.push({ kind: "chip", id: chip.id, chip });
  return items;
}

function assertUniqueSemanticIdentities(model: PaneFrameModel): void {
  const identities: Array<readonly [string, SemanticProductId]> = [["pane", model.pane.id]];
  if (model.status) identities.push(["status", model.status.id]);
  for (const chip of model.chips) identities.push(["chip", chip.id]);
  for (const action of model.actions) identities.push(["action", action.id]);

  const owners = new Map<SemanticProductId, string>();
  for (const [owner, id] of identities) {
    const previous = owners.get(id);
    if (previous) {
      throw new Error(
        `PaneFrame semantic identity must be unique: ${id} is used by ${previous} and ${owner}`,
      );
    }
    owners.set(id, owner);
  }
}

/** Shared Solid control flow for a semantic pane frame. */
export function PaneFramePresenter(props: PaneFramePresenterProps) {
  const Root = props.host.Root;
  const Header = props.host.Header;
  const Grip = props.host.Grip;
  const Title = props.host.Title;
  const Status = props.host.Status;
  const ActionList = props.host.ActionList;
  const Action = props.host.Action;
  const Body = props.host.Body;
  const frames = createKeyedRecords(
    () => {
      assertUniqueSemanticIdentities(props.model);
      return [props.model];
    },
    (model) => model.pane.id,
  );

  return (
    <For each={frames()}>
      {(frame) => {
        const model = frame.value;
        const statuses = createKeyedRecords(
          () => statusItems(model()),
          (item) => `${item.kind}:${item.id}`,
        );
        const actions = createKeyedRecords(
          () => model().actions,
          (action) => action.id,
        );
        const currentActions = () => actions().map((action) => action.value());

        return (
          <Root pane={model().pane} appearance={model().appearance}>
            <Header pane={model().pane} appearance={model().appearance}>
              <Grip
                pane={model().pane}
                appearance={model().appearance}
                onActivate={
                  props.onGripActivate
                    ? (source) =>
                        props.onGripActivate?.({ kind: "grip", paneId: model().pane.id }, source)
                    : undefined
                }
              />
              <Title
                pane={model().pane}
                appearance={model().appearance}
                title={model().title}
                subtitle={model().subtitle}
              />
              <For each={statuses()}>
                {(status) => (
                  <Status
                    pane={model().pane}
                    appearance={model().appearance}
                    item={status.value()}
                  />
                )}
              </For>
              <ActionList
                pane={model().pane}
                appearance={model().appearance}
                actions={currentActions()}
              >
                <For each={actions()}>
                  {(entry) => {
                    const interactive = () =>
                      entry.value().available &&
                      !entry.value().busy &&
                      model().appearance.action.interactive;
                    return (
                      <Action
                        pane={model().pane}
                        appearance={model().appearance}
                        action={entry.value()}
                        interactive={interactive()}
                        onActivate={
                          interactive() && props.onActionActivate
                            ? (source) => {
                                const action = entry.value();
                                props.onActionActivate?.(
                                  {
                                    kind: "action",
                                    paneId: model().pane.id,
                                    actionId: action.id,
                                    commandId: action.commandId,
                                  },
                                  source,
                                );
                              }
                            : undefined
                        }
                      />
                    );
                  }}
                </For>
              </ActionList>
            </Header>
            <Body pane={model().pane} appearance={model().appearance}>
              {props.body}
            </Body>
          </Root>
        );
      }}
    </For>
  );
}
