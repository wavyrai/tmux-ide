import {
  clampDialogTop,
  DIALOG_ROWS,
  filterDialogItems,
  followTop,
  initialSelIndex,
  type DialogConfirmSpec,
  type DialogPromptSpec,
  type DialogSelectItem,
  type DialogSelectResult,
  type DialogSelectSpec,
  type DialogSpec,
} from "./dialog-model.ts";

/** Mutable interaction state of one open dialog. */
export interface DialogEntryState {
  query: string;
  sel: number;
  top: number;
  armed: number | null;
  input: string;
  error: string | null;
  busy: boolean;
}

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

function cancelValue(spec: DialogSpec): unknown {
  return spec.kind === "confirm" ? false : null;
}

export interface DialogStack {
  top(): DialogEntry | null;
  depth(): number;
  subscribe(fn: () => void): () => void;
  push(spec: DialogSpec): Promise<unknown>;
  replace(spec: DialogSpec): Promise<unknown>;
  pop(result: unknown): void;
  dismiss(): void;
  clear(): void;
  filtered(): DialogSelectItem[];
  moveSel(delta: number): void;
  setSel(index: number): void;
  scrollBy(delta: number): void;
  activate(index: number): void;
  choose(option: number): void;
  setBusy(busy: boolean): void;
  touch(): void;
}

/** Framework-free stack engine. It owns no module-level state. */
export function createDialogStack(): DialogStack {
  const stack: DialogEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) fn();
  };
  const top = () => stack[stack.length - 1] ?? null;
  const filtered = (): DialogSelectItem[] => {
    const entry = top();
    if (!entry || entry.spec.kind !== "select") return [];
    return filterDialogItems(entry.state.query, entry.spec.items);
  };
  const applySel = (next: number) => {
    const entry = top();
    if (!entry) return;
    if (entry.spec.kind === "confirm") {
      entry.state.sel = Math.max(0, Math.min(1, next));
      notify();
      return;
    }
    if (entry.spec.kind !== "select") return;
    const rows = filtered();
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    if (clamped === entry.state.sel) return;
    entry.state.sel = clamped;
    entry.state.armed = null;
    entry.state.top = followTop(clamped, entry.state.top, DIALOG_ROWS);
    entry.spec.onMove?.(rows[clamped]!);
    notify();
  };
  const pop = (result: unknown) => {
    const entry = stack.pop();
    if (!entry) return;
    entry.resolve(result);
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
      const entry = stack.pop();
      if (entry) entry.resolve(cancelValue(entry.spec));
      return new Promise<unknown>((resolve) => {
        stack.push({ spec, state: freshState(spec), resolve });
        notify();
      });
    },
    pop,
    dismiss() {
      const entry = top();
      if (entry) pop(cancelValue(entry.spec));
    },
    clear() {
      while (stack.length > 0) {
        const entry = stack.pop()!;
        entry.resolve(cancelValue(entry.spec));
      }
      notify();
    },
    filtered,
    moveSel(delta) {
      const entry = top();
      if (entry) applySel(entry.state.sel + delta);
    },
    setSel(index) {
      applySel(index);
    },
    scrollBy(delta) {
      const entry = top();
      if (!entry || entry.spec.kind !== "select") return;
      entry.state.top = clampDialogTop(entry.state.top + delta, filtered().length, DIALOG_ROWS);
      notify();
    },
    activate(index) {
      const entry = top();
      if (!entry || entry.spec.kind !== "select") return;
      const item = filtered()[index];
      if (!item) return;
      if (index !== entry.state.sel) applySel(index);
      if (item.danger && entry.state.armed !== index) {
        entry.state.armed = index;
        notify();
        return;
      }
      pop({ item } satisfies DialogSelectResult);
    },
    choose(option) {
      const entry = top();
      if (entry?.spec.kind === "confirm") pop(option === 0);
    },
    setBusy(busy) {
      const entry = top();
      if (!entry || entry.spec.kind !== "prompt") return;
      entry.state.busy = busy;
      notify();
    },
    touch: notify,
  };
}

export interface DialogKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

function typedChar(event: DialogKeyEvent): string | null {
  if (event.ctrl || event.meta) return null;
  if (event.name === "space") return " ";
  if (event.name.length === 1) return event.shift ? event.name.toUpperCase() : event.name;
  return null;
}

/** Reduce one key against the top entry. The caller owns input suppression. */
export function dialogKey(stack: DialogStack, event: DialogKeyEvent): void {
  const entry = stack.top();
  if (!entry) return;
  const { spec, state } = entry;
  if (event.name === "escape") return stack.dismiss();
  if (spec.kind === "select") {
    if (event.name === "up") return stack.moveSel(-1);
    if (event.name === "down") return stack.moveSel(1);
    if (event.name === "return") return stack.activate(state.sel);
    if (event.ctrl && event.name.length === 1) {
      const action = (spec.actions ?? []).find((candidate) => candidate.key === event.name);
      const item = stack.filtered()[state.sel];
      if (action && item) stack.pop({ item, action: action.key } satisfies DialogSelectResult);
      return;
    }
    if (spec.filterable === false) return;
    if (event.name === "backspace") {
      state.query = state.query.slice(0, -1);
      state.sel = 0;
      state.top = 0;
      state.armed = null;
      return stack.touch();
    }
    const char = typedChar(event);
    if (char !== null) {
      state.query += char;
      state.sel = 0;
      state.top = 0;
      state.armed = null;
      return stack.touch();
    }
    return;
  }
  if (spec.kind === "prompt") {
    if (state.busy) return;
    if (event.name === "return") {
      const error = spec.validate?.(state.input) ?? null;
      if (error) {
        state.error = error;
        return stack.touch();
      }
      stack.pop(state.input);
      return;
    }
    if (event.name === "backspace") {
      state.input = state.input.slice(0, -1);
      state.error = null;
      return stack.touch();
    }
    const char = typedChar(event);
    if (char !== null) {
      state.input += char;
      state.error = null;
      return stack.touch();
    }
    return;
  }
  if (event.name === "up" || event.name === "left") return stack.setSel(0);
  if (event.name === "down" || event.name === "right") return stack.setSel(1);
  if (event.name === "return") return stack.choose(state.sel);
  if (event.name === "y") return stack.choose(0);
  if (event.name === "n") return stack.choose(1);
}

export type { DialogConfirmSpec, DialogPromptSpec, DialogSelectSpec };
