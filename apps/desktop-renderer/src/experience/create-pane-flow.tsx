import type { WorkspaceAgentRole, WorkspacePaneCreateInvocation } from "@tmux-ide/contracts";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { DomIcon } from "./dom-icon.tsx";
import {
  createPaneSubmission,
  projectCreatePaneFlow,
  type CreatePaneField,
  type CreatePaneFieldErrors,
  type CreatePaneFlowCatalogs,
  type CreatePaneKind,
} from "./create-pane-flow-presenter.ts";

type InteractionSource = "keyboard" | "mouse" | "program";

export interface CreatePaneFlowProps {
  readonly open: boolean;
  readonly catalogs: CreatePaneFlowCatalogs;
  readonly initialWorkspaceName?: string;
  readonly onOpenChange: (open: boolean, source: InteractionSource) => void;
  readonly onCommand: (invocation: WorkspacePaneCreateInvocation) => void | Promise<void>;
}

const DIALOG_TITLE_ID = "create-pane-flow-title";
const DIALOG_DESCRIPTION_ID = "create-pane-flow-description";
const WORKSPACE_FIELD_ID = "create-pane-flow-workspace";
const TITLE_FIELD_ID = "create-pane-flow-display-title";
const HARNESS_FIELD_ID = "create-pane-flow-harness";
const ROLE_FIELD_ID = "create-pane-flow-role";
const MISSION_FIELD_ID = "create-pane-flow-mission";

const ROLE_LABELS = Object.freeze({
  manager: "Manager",
  implementer: "Implementer",
  reviewer: "Reviewer",
  researcher: "Researcher",
  validator: "Validator",
} satisfies Record<WorkspaceAgentRole, string>);

function fieldElementId(field: CreatePaneField): string {
  return {
    workspaceName: WORKSPACE_FIELD_ID,
    displayTitle: TITLE_FIELD_ID,
    harnessProfileId: HARNESS_FIELD_ID,
    role: ROLE_FIELD_ID,
    missionId: MISSION_FIELD_ID,
  }[field];
}

function enabledInitialWorkspace(
  initialWorkspaceName: string | undefined,
  catalogs: ReturnType<typeof projectCreatePaneFlow>,
): string {
  if (!initialWorkspaceName || catalogs.workspaces.status !== "ready") return "";
  return catalogs.workspaces.items.some(
    (item) => item.name === initialWorkspaceName && item.available,
  )
    ? initialWorkspaceName
    : "";
}

function focusableChildren(host: HTMLElement): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      !element.closest("[hidden]") &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("inert"),
  );
}

function focusFirstFormField(host: HTMLFormElement): void {
  const field = Array.from(
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input:not(:disabled), select:not(:disabled)",
    ),
  ).find((element) => !element.closest("[hidden]"));
  field?.focus();
}

function focusInvalidField(field: CreatePaneField): void {
  const control = document.getElementById(fieldElementId(field));
  if (
    control instanceof HTMLButtonElement ||
    control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement
  ) {
    if (!control.disabled) {
      control.focus();
      return;
    }
  }
  document.getElementById(`${fieldElementId(field)}-error`)?.focus();
}

/**
 * Native tmux-ide create affordance and modal presenter.
 *
 * This component never accepts a command, cwd, session name, pane target, or
 * executable. Its only effect is the strict semantic command callback.
 */
export function CreatePaneFlow(props: CreatePaneFlowProps) {
  const projection = createMemo(() => projectCreatePaneFlow(props.catalogs));
  const [kind, setKind] = createSignal<CreatePaneKind | null>(null);
  const [workspaceName, setWorkspaceName] = createSignal("");
  const [displayTitle, setDisplayTitle] = createSignal("");
  const [harnessProfileId, setHarnessProfileId] = createSignal("");
  const [role, setRole] = createSignal<WorkspaceAgentRole>("implementer");
  const [missionId, setMissionId] = createSignal("");
  const [errors, setErrors] = createSignal<CreatePaneFieldErrors>({});
  const [dispatching, setDispatching] = createSignal(false);
  const [dispatchError, setDispatchError] = createSignal(false);
  const [transitionSource, setTransitionSource] = createSignal<InteractionSource>("program");
  let overlay: HTMLDivElement | undefined;
  let dialog: HTMLElement | undefined;
  let form: HTMLFormElement | undefined;
  let firstKindButton: HTMLButtonElement | undefined;
  let previousFocus: HTMLElement | null = null;
  let lastInteractionSource: Exclude<InteractionSource, "program"> = "keyboard";
  let openGeneration = 0;
  let disposed = false;

  const resetDraft = (): void => {
    setKind(null);
    setWorkspaceName(enabledInitialWorkspace(props.initialWorkspaceName, projection()));
    setDisplayTitle("");
    setHarnessProfileId("");
    setRole("implementer");
    setMissionId("");
    setErrors({});
    setDispatching(false);
    setDispatchError(false);
  };

  createEffect(
    on(
      () => props.open,
      (open, previousOpen) => {
        if (!overlay) return;
        overlay.inert = !open;
        if (open) {
          openGeneration += 1;
          previousFocus =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          resetDraft();
          queueMicrotask(() => {
            if (!disposed) firstKindButton?.focus();
          });
          return;
        }
        if (previousOpen) {
          queueMicrotask(() => {
            if (!disposed && previousFocus?.isConnected) previousFocus.focus();
          });
        }
      },
    ),
  );

  onCleanup(() => {
    disposed = true;
    openGeneration += 1;
    previousFocus = null;
  });

  const requestOpen = (source: InteractionSource): void => {
    if (disposed) return;
    setTransitionSource(source);
    props.onOpenChange(true, source);
  };

  const requestClose = (source: InteractionSource): void => {
    if (disposed) return;
    setTransitionSource(source);
    props.onOpenChange(false, source);
  };

  const clearError = (field: CreatePaneField): void => {
    if (!errors()[field]) return;
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const chooseKind = (nextKind: CreatePaneKind): void => {
    setKind(nextKind);
    setErrors({});
    setDispatchError(false);
    queueMicrotask(() => {
      if (!disposed && form) focusFirstFormField(form);
    });
  };

  const backToKind = (): void => {
    setKind(null);
    setErrors({});
    setDispatchError(false);
    queueMicrotask(() => {
      if (!disposed) firstKindButton?.focus();
    });
  };

  const submit = async (source: Exclude<InteractionSource, "program">): Promise<void> => {
    const selectedKind = kind();
    if (!selectedKind || dispatching()) return;
    const submission = createPaneSubmission(
      projection(),
      {
        kind: selectedKind,
        workspaceName: workspaceName(),
        displayTitle: displayTitle(),
        harnessProfileId: harnessProfileId(),
        role: role(),
        missionId: missionId(),
      },
      { kind: source, surface: "create-pane-dialog" },
    );
    if (!submission.ok) {
      setErrors(submission.errors);
      setDispatchError(false);
      queueMicrotask(() => {
        if (!disposed) focusInvalidField(submission.firstInvalidField);
      });
      return;
    }

    const generation = openGeneration;
    setErrors({});
    setDispatchError(false);
    setDispatching(true);
    try {
      await props.onCommand(submission.invocation);
      if (disposed || generation !== openGeneration) return;
      if (props.open) requestClose(source);
    } catch {
      if (disposed || generation !== openGeneration) return;
      if (props.open) setDispatchError(true);
    } finally {
      if (!disposed && generation === openGeneration) setDispatching(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent): void => {
    lastInteractionSource = "keyboard";
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose("keyboard");
      return;
    }
    if (event.key === "Tab" && dialog) {
      const focusable = focusableChildren(dialog);
      if (focusable.length === 0) return;
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    const target = event.target;
    if (target instanceof HTMLButtonElement && target.dataset.enterAction === "true") {
      event.preventDefault();
      target.click();
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "text" && kind()) {
      event.preventDefault();
      void submit("keyboard");
    }
  };

  const catalogWarningCount = createMemo(
    () =>
      projection().workspaces.invalidOptionCount +
      projection().harnessProfiles.invalidOptionCount +
      projection().missions.invalidOptionCount,
  );

  return (
    <div class="create-pane-flow">
      <button
        id="create-pane-flow-trigger"
        class="create-pane-flow__trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        aria-controls="create-pane-flow-dialog"
        title="New terminal or agent"
        onClick={(event) => requestOpen(event.detail === 0 ? "keyboard" : "mouse")}
      >
        <span aria-hidden="true">+</span>
        <span class="sr-only">New terminal or agent</span>
      </button>

      <div
        ref={(element) => {
          overlay = element;
          element.inert = !props.open;
        }}
        class="create-pane-flow__overlay"
        classList={{ "create-pane-flow__overlay--open": props.open }}
        aria-hidden={props.open ? "false" : "true"}
        data-overlay-root="true"
        data-transition-source={transitionSource()}
        onMouseDown={(event) => {
          lastInteractionSource = "mouse";
          if (event.target === event.currentTarget) requestClose("mouse");
        }}
      >
        <section
          ref={(element) => {
            dialog = element;
          }}
          id="create-pane-flow-dialog"
          class="create-pane-flow__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={DIALOG_TITLE_ID}
          aria-describedby={DIALOG_DESCRIPTION_ID}
          aria-busy={dispatching()}
          onKeyDown={handleDialogKeyDown}
        >
          <header class="create-pane-flow__header">
            <span>
              <small>tmux-backed workspace</small>
              <h2 id={DIALOG_TITLE_ID}>New terminal or agent</h2>
            </span>
            <button
              type="button"
              class="create-pane-flow__close"
              aria-label="Close create dialog"
              title="Close (Esc)"
              onClick={(event) => requestClose(event.detail === 0 ? "keyboard" : "mouse")}
            >
              <DomIcon id="close" usage="action" />
            </button>
          </header>
          <p id={DIALOG_DESCRIPTION_ID} class="create-pane-flow__description">
            tmux-ide resolves processes, directories, and panes. Choose only the product resources
            you want to create.
          </p>

          <div class="create-pane-flow__kind" hidden={kind() !== null}>
            <p class="create-pane-flow__eyebrow">What do you want to add?</p>
            <div class="create-pane-flow__kind-grid" role="group" aria-label="Creation type">
              <button
                ref={(element) => {
                  firstKindButton = element;
                }}
                type="button"
                class="create-pane-flow__kind-card"
                data-enter-action="true"
                onClick={() => chooseKind("terminal")}
              >
                <DomIcon id="terminals" usage="rail" />
                <strong>Terminal</strong>
                <span>A native terminal view backed by a daemon-owned tmux pane.</span>
                <kbd>↵</kbd>
              </button>
              <button
                type="button"
                class="create-pane-flow__kind-card"
                data-enter-action="true"
                onClick={() => chooseKind("agent")}
              >
                <DomIcon id="missions" usage="rail" />
                <strong>Agent</strong>
                <span>Start an exposed harness profile with a role and optional mission.</span>
                <kbd>↵</kbd>
              </button>
            </div>
          </div>

          <form
            ref={(element) => {
              form = element;
            }}
            class="create-pane-flow__form"
            hidden={kind() === null}
            novalidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit(lastInteractionSource);
            }}
          >
            <div class="create-pane-flow__form-heading">
              <button type="button" data-enter-action="true" onClick={backToKind}>
                ← Choose type
              </button>
              <span data-kind={kind() ?? undefined}>
                {kind() === "agent" ? "Agent" : "Terminal"}
              </span>
            </div>

            <label class="create-pane-flow__field" for={WORKSPACE_FIELD_ID}>
              <span>
                Workspace <b aria-hidden="true">*</b>
              </span>
              <select
                id={WORKSPACE_FIELD_ID}
                value={workspaceName()}
                disabled={projection().workspaces.status !== "ready"}
                required
                aria-required="true"
                aria-invalid={Boolean(errors().workspaceName)}
                aria-describedby={
                  errors().workspaceName ? `${WORKSPACE_FIELD_ID}-error` : undefined
                }
                onChange={(event) => {
                  setWorkspaceName(event.currentTarget.value);
                  clearError("workspaceName");
                }}
              >
                <option value="">
                  {projection().workspaces.status === "loading"
                    ? "Loading workspaces…"
                    : projection().workspaces.status === "unavailable"
                      ? "Workspaces unavailable"
                      : projection().workspaces.items.length === 0
                        ? "No workspaces available"
                        : "Choose a workspace…"}
                </option>
                <For each={projection().workspaces.items}>
                  {(workspace) => (
                    <option value={workspace.name} disabled={!workspace.available}>
                      {workspace.label}
                      {workspace.available ? "" : " — unavailable"}
                    </option>
                  )}
                </For>
              </select>
              <Show when={errors().workspaceName}>
                {(message) => (
                  <small
                    id={`${WORKSPACE_FIELD_ID}-error`}
                    class="create-pane-flow__error"
                    role="alert"
                    tabIndex={-1}
                  >
                    {message()}
                  </small>
                )}
              </Show>
              <Show
                when={
                  projection().workspaces.status === "ready" &&
                  projection().workspaces.items.length === 0
                }
              >
                <small class="create-pane-flow__empty">
                  Open a project from Home, then return here to create its first terminal.
                </small>
              </Show>
            </label>

            <label class="create-pane-flow__field" for={TITLE_FIELD_ID}>
              <span>
                Display title <em>optional</em>
              </span>
              <input
                id={TITLE_FIELD_ID}
                type="text"
                maxlength={80}
                value={displayTitle()}
                placeholder={kind() === "agent" ? "API implementer" : "Release shell"}
                aria-invalid={Boolean(errors().displayTitle)}
                aria-describedby={
                  errors().displayTitle ? `${TITLE_FIELD_ID}-error` : `${TITLE_FIELD_ID}-hint`
                }
                onInput={(event) => {
                  setDisplayTitle(event.currentTarget.value);
                  clearError("displayTitle");
                }}
              />
              <small id={`${TITLE_FIELD_ID}-hint`}>
                Presentation only; it never becomes a command.
              </small>
              <Show when={errors().displayTitle}>
                {(message) => (
                  <small
                    id={`${TITLE_FIELD_ID}-error`}
                    class="create-pane-flow__error"
                    role="alert"
                    tabIndex={-1}
                  >
                    {message()}
                  </small>
                )}
              </Show>
            </label>

            <div class="create-pane-flow__agent-fields" hidden={kind() !== "agent"}>
              <label class="create-pane-flow__field" for={HARNESS_FIELD_ID}>
                <span>
                  Agent profile <b aria-hidden="true">*</b>
                </span>
                <select
                  id={HARNESS_FIELD_ID}
                  value={harnessProfileId()}
                  disabled={projection().harnessProfiles.status !== "ready"}
                  required
                  aria-required="true"
                  aria-invalid={Boolean(errors().harnessProfileId)}
                  aria-describedby={
                    errors().harnessProfileId ? `${HARNESS_FIELD_ID}-error` : undefined
                  }
                  onChange={(event) => {
                    setHarnessProfileId(event.currentTarget.value);
                    clearError("harnessProfileId");
                  }}
                >
                  <option value="">
                    {projection().harnessProfiles.status === "loading"
                      ? "Loading agent profiles…"
                      : projection().harnessProfiles.status === "unavailable"
                        ? "Agent profiles unavailable"
                        : projection().harnessProfiles.items.length === 0
                          ? "No agent profiles available"
                          : "Choose an agent profile…"}
                  </option>
                  <For each={projection().harnessProfiles.items}>
                    {(harness) => (
                      <option value={harness.id} disabled={!harness.available}>
                        {harness.label}
                        {harness.available ? "" : " — unavailable"}
                      </option>
                    )}
                  </For>
                </select>
                <Show when={errors().harnessProfileId}>
                  {(message) => (
                    <small
                      id={`${HARNESS_FIELD_ID}-error`}
                      class="create-pane-flow__error"
                      role="alert"
                      tabIndex={-1}
                    >
                      {message()}
                    </small>
                  )}
                </Show>
                <Show
                  when={
                    projection().harnessProfiles.status === "ready" &&
                    projection().harnessProfiles.items.length === 0
                  }
                >
                  <small class="create-pane-flow__empty">
                    No profiles are exposed yet. Add one from Workspace settings.
                  </small>
                </Show>
              </label>

              <div class="create-pane-flow__field-row">
                <label class="create-pane-flow__field" for={ROLE_FIELD_ID}>
                  <span>Role</span>
                  <select
                    id={ROLE_FIELD_ID}
                    value={role()}
                    aria-invalid={Boolean(errors().role)}
                    aria-describedby={errors().role ? `${ROLE_FIELD_ID}-error` : undefined}
                    onChange={(event) => {
                      setRole(event.currentTarget.value as WorkspaceAgentRole);
                      clearError("role");
                    }}
                  >
                    <For each={projection().roles}>
                      {(roleOption) => (
                        <option value={roleOption}>{ROLE_LABELS[roleOption]}</option>
                      )}
                    </For>
                  </select>
                  <Show when={errors().role}>
                    {(message) => (
                      <small
                        id={`${ROLE_FIELD_ID}-error`}
                        class="create-pane-flow__error"
                        role="alert"
                        tabIndex={-1}
                      >
                        {message()}
                      </small>
                    )}
                  </Show>
                </label>

                <label class="create-pane-flow__field" for={MISSION_FIELD_ID}>
                  <span>
                    Mission <em>optional</em>
                  </span>
                  <select
                    id={MISSION_FIELD_ID}
                    value={missionId()}
                    disabled={projection().missions.status !== "ready"}
                    aria-invalid={Boolean(errors().missionId)}
                    aria-describedby={errors().missionId ? `${MISSION_FIELD_ID}-error` : undefined}
                    onChange={(event) => {
                      setMissionId(event.currentTarget.value);
                      clearError("missionId");
                    }}
                  >
                    <option value="">
                      {projection().missions.status === "loading"
                        ? "Loading missions…"
                        : projection().missions.status === "unavailable"
                          ? "Missions unavailable"
                          : "No mission"}
                    </option>
                    <For each={projection().missions.items}>
                      {(mission) => (
                        <option value={mission.id} disabled={!mission.available}>
                          {mission.label}
                        </option>
                      )}
                    </For>
                  </select>
                  <Show when={errors().missionId}>
                    {(message) => (
                      <small
                        id={`${MISSION_FIELD_ID}-error`}
                        class="create-pane-flow__error"
                        role="alert"
                        tabIndex={-1}
                      >
                        {message()}
                      </small>
                    )}
                  </Show>
                </label>
              </div>
            </div>

            <Show when={catalogWarningCount() > 0}>
              <p class="create-pane-flow__notice" role="status">
                Some invalid catalog choices were safely omitted.
              </p>
            </Show>
            <Show when={dispatchError()}>
              <p class="create-pane-flow__notice create-pane-flow__notice--error" role="alert">
                tmux-ide could not submit this request. Your selections are still here.
              </p>
            </Show>

            <footer class="create-pane-flow__footer">
              <span>Esc cancel · ↵ create</span>
              <button
                type="submit"
                class="create-pane-flow__submit"
                data-enter-action="true"
                disabled={dispatching()}
              >
                {dispatching() ? `Creating ${kind() ?? "pane"}…` : `Create ${kind() ?? "pane"}`}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </div>
  );
}
