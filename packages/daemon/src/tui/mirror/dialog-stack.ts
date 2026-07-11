/**
 * The global dialog STACK (M22.4) — one overlay mount in app.tsx renders
 * whatever is on top; everything else is state here, framework-free so it
 * unit-tests without OpenTUI.
 *
 * The API is Promise-based one-shots, so multi-step flows read as sequential
 * awaits:
 *
 *   const choice = await DialogSelect.show({ title, items });
 *   if (choice && (await DialogConfirm.show({ title: "Sure?" }))) { … }
 *
 * `push` may be called while another dialog is open — the new one stacks on
 * top and only IT renders/receives input; resolving it reveals the one below.
 * Escape (and a click outside the box) pops ONE level, resolving that dialog
 * with its cancel value (`null`, or `false` for confirms). `replace` swaps the
 * top in place; `clear` cancels the whole stack (quit paths).
 *
 * INPUT while a dialog is open is fully owned here: app.tsx feeds every key to
 * {@link dialogKey} and every pointer event to its dialog route block FIRST, so
 * nothing leaks to panes/editor underneath. Selection changes — keyboard and
 * mouse alike — funnel through one place, which is where a select's `onMove`
 * live-preview hook fires (never on open) and where an armed destructive row
 * disarms.
 *
 * Solid bridge: the stack is not reactive; app.tsx subscribes and bumps a
 * `dialogRev` signal on every notification (the `editorRev` idiom).
 */
import {
  filterDialogItems,
  initialSelIndex,
  followTop,
  clampDialogTop,
  DIALOG_ROWS,
  type DialogConfirmSpec,
  type DialogPromptSpec,
  type DialogSelectItem,
  type DialogSelectResult,
  type DialogSelectSpec,
  type DialogSpec,
} from "./dialog-model.ts";

/** Mutable interaction state of one open dialog. */
export interface DialogEntryState {
  /** select: the filter query. */
  query: string;
  /** select/confirm: the selected row (select: index into the FILTERED list). */
  sel: number;
  /** select: the scroll window top. */
  top: number;
  /** select: the armed destructive row (filtered index), disarmed on any move. */
  armed: number | null;
  /** prompt: the typed value. */
  input: string;
  /** prompt: the current validation error. */
  error: string | null;
  /** prompt: a busy flag the caller may set while persisting. */
  busy: boolean;
}

/** One stack entry: the spec, its interaction state, and the pending resolver. */
export interface DialogEntry {
  spec: DialogSpec;
  state: DialogEntryState;
  resolve: (result: unknown) => void;
}

function freshState(spec: DialogSpec): DialogEntryState {
  return {
    query: "",
    sel:
      spec.kind === "select"
        ? initialSelIndex(spec)
        : spec.kind === "confirm" && spec.defaultNo
          ? 1
          : 0,
    top: 0,
    armed: null,
    input: spec.kind === "prompt" ? (spec.initial ?? "") : "",
    error: null,
    busy: false,
  };
}

/** The cancel value a dismissed dialog resolves with. */
function cancelValue(spec: DialogSpec): unknown {
  return spec.kind === "confirm" ? false : null;
}

export interface DialogStack {
  /** The rendered/driven entry — the top of the stack, or null. */
  top(): DialogEntry | null;
  depth(): number;
  /** Re-render notifications (app.tsx bumps a signal). Returns unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Open a dialog ON TOP; resolves when it closes. */
  push(spec: DialogSpec): Promise<unknown>;
  /** Swap the top dialog in place (its promise resolves with the cancel value). */
  replace(spec: DialogSpec): Promise<unknown>;
  /** Resolve + remove the top entry. */
  pop(result: unknown): void;
  /** Pop ONE level with its cancel value — what Escape and a click outside do. */
  dismiss(): void;
  /** Cancel every open dialog (bottom-up resolves with cancel values). */
  clear(): void;
  /** The top select's rows for its current query. */
  filtered(): DialogSelectItem[];
  /** Move the selection by delta (select/confirm) — fires onMove, follows scroll. */
  moveSel(delta: number): void;
  /** Set the selection to a FILTERED index (mouse motion) — fires onMove. */
  setSel(index: number): void;
  /** Wheel: shift the select window top by delta rows. */
  scrollBy(delta: number): void;
  /** Activate a filtered row (enter / click): arms danger rows first. */
  activate(index: number): void;
  /** Confirm: resolve option 0 (true) / 1 (false). */
  choose(option: number): void;
  /** Prompt: mark busy (footer shows "saving…", input ignores keys). */
  setBusy(busy: boolean): void;
  /** Notify subscribers after a direct state mutation (query/input edits). */
  touch(): void;
}

export function createDialogStack(): DialogStack {
  const stack: DialogEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) fn();
  };

  const top = () => stack[stack.length - 1] ?? null;

  const filtered = (): DialogSelectItem[] => {
    const e = top();
    if (!e || e.spec.kind !== "select") return [];
    return filterDialogItems(e.state.query, e.spec.items);
  };

  /** Central selection change — the ONLY place `sel` moves, so onMove and the
   *  danger disarm can't be bypassed by one of the two input paths. */
  const applySel = (next: number) => {
    const e = top();
    if (!e) return;
    if (e.spec.kind === "confirm") {
      e.state.sel = Math.max(0, Math.min(1, next));
      notify();
      return;
    }
    if (e.spec.kind !== "select") return;
    const rows = filtered();
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    if (clamped === e.state.sel) return;
    e.state.sel = clamped;
    e.state.armed = null;
    e.state.top = followTop(clamped, e.state.top, DIALOG_ROWS);
    e.spec.onMove?.(rows[clamped]!);
    notify();
  };

  const pop = (result: unknown) => {
    const e = stack.pop();
    if (!e) return;
    e.resolve(result);
    notify();
  };

  return {
    top,
    depth: () => stack.length,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    push(spec) {
      return new Promise<unknown>((resolve) => {
        stack.push({ spec, state: freshState(spec), resolve });
        notify();
      });
    },
    replace(spec) {
      const e = stack.pop();
      if (e) e.resolve(cancelValue(e.spec));
      return new Promise<unknown>((resolve) => {
        stack.push({ spec, state: freshState(spec), resolve });
        notify();
      });
    },
    pop,
    dismiss() {
      const e = top();
      if (e) pop(cancelValue(e.spec));
    },
    clear() {
      while (stack.length > 0) {
        const e = stack.pop()!;
        e.resolve(cancelValue(e.spec));
      }
      notify();
    },
    filtered,
    moveSel(delta) {
      const e = top();
      if (!e) return;
      applySel(e.state.sel + delta);
    },
    setSel(index) {
      applySel(index);
    },
    scrollBy(delta) {
      const e = top();
      if (!e || e.spec.kind !== "select") return;
      e.state.top = clampDialogTop(e.state.top + delta, filtered().length, DIALOG_ROWS);
      notify();
    },
    activate(index) {
      const e = top();
      if (!e || e.spec.kind !== "select") return;
      const rows = filtered();
      const item = rows[index];
      if (!item) return;
      if (index !== e.state.sel) applySel(index);
      if (item.danger && e.state.armed !== index) {
        // Inline destructive confirm — the row itself asks again, no modal.
        e.state.armed = index;
        notify();
        return;
      }
      pop({ item } satisfies DialogSelectResult);
    },
    choose(option) {
      const e = top();
      if (!e || e.spec.kind !== "confirm") return;
      pop(option === 0);
    },
    setBusy(busy) {
      const e = top();
      if (!e || e.spec.kind !== "prompt") return;
      e.state.busy = busy;
      notify();
    },
    touch: notify,
  };
}

/** THE stack — one per app process; the overlay mount and the routers all
 *  address this instance. */
export const dialogStack = createDialogStack();

// ── One-shot façades (the exploration's API shape) ───────────────────────────

export const DialogSelect = {
  /** Open a select; resolves the chosen row (+ action key) or null on cancel. */
  show(spec: Omit<DialogSelectSpec, "kind">, stack: DialogStack = dialogStack) {
    return stack.push({ kind: "select", ...spec }) as Promise<DialogSelectResult | null>;
  },
};

export const DialogPrompt = {
  /** Open a prompt; resolves the (validated) text or null on cancel. */
  show(spec: Omit<DialogPromptSpec, "kind">, stack: DialogStack = dialogStack) {
    return stack.push({ kind: "prompt", ...spec }) as Promise<string | null>;
  },
};

export const DialogConfirm = {
  /** Open a two-option confirm; resolves true only on the affirmative. */
  show(spec: Omit<DialogConfirmSpec, "kind">, stack: DialogStack = dialogStack) {
    return stack.push({ kind: "confirm", ...spec }) as Promise<boolean>;
  },
};

// ── The keyboard reducer ─────────────────────────────────────────────────────

/** The key-event shape app.tsx feeds (matches its useKeyboard events). */
export interface DialogKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/** The typed character a key event contributes to a filter/prompt, or null.
 *  OpenTUI names the space key `"space"` (not a 1-char name), so the bare
 *  length-1 check silently DROPPED every space — a custom command with flags
 *  could never be typed (measured live, M24.1). */
function typedChar(evt: DialogKeyEvent): string | null {
  if (evt.ctrl || evt.meta) return null;
  if (evt.name === "space") return " ";
  if (evt.name.length === 1) return evt.shift ? evt.name.toUpperCase() : evt.name;
  return null;
}

/**
 * Feed one key to the stack's top dialog. Centralized ESCAPE lives here: it
 * pops exactly one level. The caller must treat EVERY key as consumed while
 * `stack.depth() > 0` (input suppression — nothing forwards to panes).
 */
export function dialogKey(stack: DialogStack, evt: DialogKeyEvent): void {
  const e = stack.top();
  if (!e) return;
  const { spec, state } = e;
  if (evt.name === "escape") {
    stack.dismiss();
    return;
  }
  if (spec.kind === "select") {
    if (evt.name === "up") return stack.moveSel(-1);
    if (evt.name === "down") return stack.moveSel(1);
    if (evt.name === "return") return stack.activate(state.sel);
    // Per-row actions ride ctrl+<key> so they never collide with filter typing.
    if (evt.ctrl && evt.name.length === 1) {
      const action = (spec.actions ?? []).find((a) => a.key === evt.name);
      const item = stack.filtered()[state.sel];
      if (action && item) {
        stack.pop({ item, action: action.key } satisfies DialogSelectResult);
      }
      return;
    }
    if (spec.filterable === false) return;
    if (evt.name === "backspace") {
      state.query = state.query.slice(0, -1);
      state.sel = 0;
      state.top = 0;
      state.armed = null;
      return stack.touch();
    }
    const ch = typedChar(evt);
    if (ch !== null) {
      state.query += ch;
      state.sel = 0;
      state.top = 0;
      state.armed = null;
      return stack.touch();
    }
    return;
  }
  if (spec.kind === "prompt") {
    if (state.busy) return; // a persisting prompt ignores edits
    if (evt.name === "return") {
      const err = spec.validate?.(state.input) ?? null;
      if (err) {
        state.error = err;
        return stack.touch();
      }
      stack.pop(state.input);
      return;
    }
    if (evt.name === "backspace") {
      state.input = state.input.slice(0, -1);
      state.error = null;
      return stack.touch();
    }
    const ch = typedChar(evt);
    if (ch !== null) {
      state.input += ch;
      state.error = null;
      return stack.touch();
    }
    return;
  }
  // confirm
  if (evt.name === "up" || evt.name === "left") return stack.setSel(0);
  if (evt.name === "down" || evt.name === "right") return stack.setSel(1);
  if (evt.name === "return") return stack.choose(state.sel);
  if (evt.name === "y") return stack.choose(0);
  if (evt.name === "n") return stack.choose(1);
}
