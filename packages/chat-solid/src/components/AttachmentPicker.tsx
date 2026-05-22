import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { ComposerAttachment, ComposerTerminalPane } from "../types";

type PickerTab = "terminal" | "file";

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean).at(-1) || trimmed;
}

function inferredHome(projectDir: string | null | undefined): string | null {
  if (!projectDir) return null;
  const match = projectDir.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  return match?.[1] ?? null;
}

function expandPath(path: string, projectDir: string | null | undefined): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("~/")) return trimmed;
  const home = inferredHome(projectDir);
  return home ? `${home}/${trimmed.slice(2)}` : trimmed;
}

export function AttachmentPicker(props: {
  open: Accessor<boolean>;
  sessionName: Accessor<string | null>;
  projectDir: Accessor<string | undefined>;
  terminalPanes: Accessor<ComposerTerminalPane[]>;
  onAdd(attachment: ComposerAttachment): void;
  onClose(): void;
}) {
  const [root, setRoot] = createSignal<HTMLDivElement>();
  const [tab, setTab] = createSignal<PickerTab>("terminal");
  const [paneId, setPaneId] = createSignal("");
  const [filePath, setFilePath] = createSignal("");

  createEffect(() => {
    if (!props.open()) return;
    const onPointerDown = (event: PointerEvent) => {
      const element = root();
      if (!element || element.contains(event.target as Node)) return;
      props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  function addPane(pane: ComposerTerminalPane): void {
    props.onAdd({
      kind: "terminal",
      paneId: pane.paneId,
      paneTitle: pane.paneTitle,
      sessionName: pane.sessionName,
    });
    props.onClose();
  }

  function addManualPane(): void {
    const id = paneId().trim();
    const sessionName = props.sessionName();
    if (!id || !sessionName) return;
    props.onAdd({
      kind: "terminal",
      paneId: id,
      paneTitle: id,
      sessionName,
    });
    setPaneId("");
    props.onClose();
  }

  function addFile(): void {
    const path = expandPath(filePath(), props.projectDir());
    if (!path) return;
    props.onAdd({ kind: "file", path, label: basename(path) });
    setFilePath("");
    props.onClose();
  }

  return (
    <Show when={props.open()}>
      <div
        ref={setRoot}
        class="absolute bottom-full right-0 z-20 mb-2 w-[320px] max-w-[calc(100vw-24px)] rounded-md border border-border bg-surface-elevated p-3 shadow-2xl"
      >
        <div class="mb-3 flex rounded-md border border-border-weak bg-bg p-0.5">
          <button
            type="button"
            class={`flex-1 rounded px-2 py-1 text-base ${
              tab() === "terminal" ? "bg-surface-hover text-fg" : "text-dim hover:text-fg"
            }`}
            onClick={() => setTab("terminal")}
          >
            Terminal
          </button>
          <button
            type="button"
            class={`flex-1 rounded px-2 py-1 text-base ${
              tab() === "file" ? "bg-surface-hover text-fg" : "text-dim hover:text-fg"
            }`}
            onClick={() => setTab("file")}
          >
            File
          </button>
        </div>

        <Show when={tab() === "terminal"}>
          <div class="max-h-48 overflow-auto">
            <Show
              when={props.terminalPanes().length > 0}
              fallback={
                <div class="space-y-2">
                  <div class="text-base text-dim">Enter a tmux pane id</div>
                  <div class="flex gap-2">
                    <input
                      class="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-base text-fg outline-none focus:border-accent"
                      value={paneId()}
                      disabled={!props.sessionName()}
                      placeholder="%1"
                      aria-label="Terminal pane id"
                      onInput={(event) => setPaneId(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addManualPane();
                      }}
                    />
                    <button
                      type="button"
                      class="rounded-md border border-border bg-bg px-2 text-base text-fg-secondary hover:border-accent hover:text-accent disabled:opacity-45"
                      disabled={!paneId().trim() || !props.sessionName()}
                      onClick={addManualPane}
                    >
                      Add
                    </button>
                  </div>
                </div>
              }
            >
              <For each={props.terminalPanes()}>
                {(pane) => (
                  <button
                    type="button"
                    class="block w-full rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-base text-fg hover:bg-surface-hover"
                    onClick={() => addPane(pane)}
                  >
                    <span class="block truncate">{pane.paneTitle}</span>
                    <span class="block truncate text-sm text-dim">
                      {pane.paneId}
                      {pane.currentCommand ? ` - ${pane.currentCommand}` : ""}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>

        <Show when={tab() === "file"}>
          <input
            class="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-base text-fg outline-none placeholder:text-dim focus:border-accent"
            value={filePath()}
            placeholder="/tmp/output.log or ~/notes.md"
            aria-label="File path"
            onInput={(event) => setFilePath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addFile();
            }}
          />
        </Show>
      </div>
    </Show>
  );
}
