/* @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid";
import { createSignal, For } from "solid-js";
import {
  applyRecipeGalleryCommand,
  createRecipeGalleryModel,
  recipeGalleryCommandForKey,
  recipeGalleryHitTest,
  recipeGalleryLayout,
  recipeGalleryTheme,
  type RecipeGalleryLayout,
  type RecipeGalleryModel,
} from "./recipes.ts";
import {
  Badge,
  Button,
  EmptyState,
  InputShell,
  KeyHint,
  Scrollbar,
  SectionHeader,
  SegmentedControl,
  SelectableRow,
  Surface,
} from "./recipes.tsx";
import { clipTerminal } from "./missions-workspace.ts";

export interface RecipesGalleryProps {
  width: number;
  height: number;
  initial?: RecipeGalleryModel;
  onModel?: (model: RecipeGalleryModel) => void;
}

function RecipeItem(props: {
  layout: RecipeGalleryLayout;
  item: RecipeGalleryLayout["items"][number];
  model: RecipeGalleryModel;
}) {
  const theme = () => recipeGalleryTheme(props.model.mode);
  const active = () => props.model.selectedId === props.item.id;
  const pressed = () => props.model.pressedId === props.item.id;
  const bodyWidth = () => Math.max(0, props.item.width - 2);
  return (
    <box
      x={props.item.x}
      y={props.item.y}
      width={props.item.width}
      height={props.item.height}
      flexDirection="column"
      overflow="hidden"
      position="absolute"
    >
      {props.item.kind === "surface" ? (
        <Surface
          theme={theme()}
          title="Panel"
          width={props.item.width}
          height={props.item.height}
          focused={active()}
        >
          <text fg={theme().colors.mutedForeground}> app-owned chrome </text>
        </Surface>
      ) : props.item.kind === "section" ? (
        <>
          <SectionHeader
            theme={theme()}
            title="SectionHeader"
            detail="detail"
            focused={active()}
            width={props.item.width}
          />
          <SelectableRow
            theme={theme()}
            label="consistent spacing"
            meta="pure"
            width={props.item.width}
          />
        </>
      ) : props.item.kind === "row" ? (
        <>
          <SelectableRow
            theme={theme()}
            label="Blocked selected row keeps status marker"
            meta="blocked"
            width={props.item.width}
            selected
            hovered
            tone="blocked"
            status="blocked"
          />
          <SelectableRow
            theme={theme()}
            label="Attention beats pointer hover"
            meta="flash"
            width={props.item.width}
            attention
            hovered
          />
          <SelectableRow
            theme={theme()}
            label="Disabled row"
            meta="locked"
            width={props.item.width}
            disabled
          />
        </>
      ) : props.item.kind === "button" ? (
        <>
          <Button
            theme={theme()}
            label="Run action"
            width={Math.min(18, props.item.width)}
            focused={active()}
            pressed={pressed()}
          />
          <Button theme={theme()} label="Loading" width={Math.min(16, props.item.width)} loading />
          <Button
            theme={theme()}
            label="Disabled"
            width={Math.min(16, props.item.width)}
            disabled
          />
        </>
      ) : props.item.kind === "badge" ? (
        <box flexDirection="row" gap={1} overflow="hidden">
          <Badge theme={theme()} label="blocked" tone="blocked" width={10} />
          <Badge theme={theme()} label="done" tone="done" width={7} />
          <Badge theme={theme()} label="idle" tone="idle" width={7} />
        </box>
      ) : props.item.kind === "tabs" ? (
        <>
          <SegmentedControl
            theme={theme()}
            width={props.item.width}
            activeId="board"
            focusedId={active() ? "history" : undefined}
            items={[
              { id: "board", label: "Board" },
              { id: "history", label: "History" },
              { id: "detail", label: "Detail" },
            ]}
          />
          <text fg={theme().colors.mutedForeground}> segmented control </text>
        </>
      ) : props.item.kind === "input" ? (
        <>
          <InputShell
            theme={theme()}
            value={active() ? "typed query" : ""}
            placeholder="Search…"
            width={props.item.width}
            focused={active()}
          />
          <text fg={theme().colors.mutedForeground}> shell only; app owns text </text>
        </>
      ) : props.item.kind === "keyhint" ? (
        <>
          <KeyHint theme={theme()} keys="t" label="toggle theme" width={props.item.width} />
          <KeyHint
            theme={theme()}
            keys="enter"
            label="activate focused recipe"
            width={props.item.width}
          />
        </>
      ) : props.item.kind === "empty" ? (
        <EmptyState
          theme={theme()}
          title="Nothing here"
          detail="empty/loading states stay explicit"
          width={props.item.width}
        />
      ) : (
        <box flexDirection="row" overflow="hidden">
          <box width={Math.max(1, bodyWidth())} flexDirection="column">
            <text fg={theme().colors.foreground}>
              {clipTerminal("Scroll content", bodyWidth())}
            </text>
            <text fg={theme().colors.mutedForeground}>
              {clipTerminal("top follows model", bodyWidth())}
            </text>
          </box>
          <Scrollbar
            theme={theme()}
            contentRows={24}
            viewportRows={6}
            top={active() ? 9 : 3}
            height={props.item.height}
          />
        </box>
      )}
    </box>
  );
}

export function RecipesGallery(props: RecipesGalleryProps) {
  const [model, setModel] = createSignal(props.initial ?? createRecipeGalleryModel());
  const updateModel = (next: RecipeGalleryModel) => {
    setModel(next);
    props.onModel?.(next);
  };
  const layout = () => recipeGalleryLayout(props.width, props.height, model().mode);
  const theme = () => recipeGalleryTheme(model().mode);
  useKeyboard((event) => {
    const command = recipeGalleryCommandForKey(event.name, event.ctrl, event.meta);
    if (command !== "none") updateModel(applyRecipeGalleryCommand(model(), command));
  });
  return (
    <box
      width={props.width}
      height={props.height}
      overflow="hidden"
      backgroundColor={theme().colors.background}
      onMouseDown={(event) => {
        const hit = recipeGalleryHitTest(layout(), event.x, event.y);
        if (hit) updateModel(applyRecipeGalleryCommand(model(), "none", hit));
      }}
    >
      <box
        x={0}
        y={0}
        width={props.width}
        height={2}
        position="absolute"
        flexDirection="column"
        overflow="hidden"
      >
        <text fg={theme().colors.accent}>
          {clipTerminal(` tmux-ide recipe gallery · ${model().mode}`, props.width)}
        </text>
        <text fg={theme().colors.mutedForeground}>
          {clipTerminal(` ${model().message}`, props.width)}
        </text>
      </box>
      <For each={layout().items}>
        {(item) => <RecipeItem layout={layout()} item={item} model={model()} />}
      </For>
      <box
        x={0}
        y={Math.max(0, props.height - 1)}
        width={props.width}
        height={1}
        position="absolute"
        overflow="hidden"
      >
        <text fg={theme().colors.mutedForeground}>
          {clipTerminal(
            " tab/j move · enter/space activate · t theme · mouse selects",
            props.width,
          )}
        </text>
      </box>
    </box>
  );
}
