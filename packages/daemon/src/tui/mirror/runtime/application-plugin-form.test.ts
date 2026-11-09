import { hasUnsafeText, type CommandParam } from "@tmux-ide/contracts";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationPluginPaletteCommand } from "../workspace/application-command-description.ts";
import {
  createApplicationPluginForm,
  pluginPaletteContext,
  type PluginFormService,
} from "./application-plugin-form.ts";

const param = (overrides: Partial<CommandParam> & Pick<CommandParam, "name">): CommandParam => ({
  type: "string",
  label: overrides.name,
  required: true,
  dynamicDefault: false,
  dynamicChoices: false,
  ...overrides,
});

const command = (params: CommandParam[], dangerous = false): ApplicationPluginPaletteCommand => ({
  kind: "plugin-command",
  id: "plugin.tasks.new",
  label: "New task",
  category: "Tasks",
  plugin: "tasks",
  dangerous,
  params,
});

function harness(service: Partial<PluginFormService> = {}) {
  const [query, setQuery] = createSignal("");
  const notes: (string | null)[] = [];
  const close = vi.fn();
  const stepChanged = vi.fn(() => setQuery(""));
  const invoke = vi.fn(service.invoke ?? (async () => ({ ok: true as const, value: "made it" })));
  const paramOptions = vi.fn(
    service.paramOptions ??
      (async () => ({ ok: true as const, choices: [{ value: "a", label: "A" }], default: "a" })),
  );
  const form = createApplicationPluginForm({
    service: { invoke, paramOptions },
    context: () => ({ source: "palette", session: "demo", pane: "%3" }),
    query,
    setNote: (note) => notes.push(note),
    close,
    stepChanged,
  });
  const choose = (key: string) => {
    const entry = form.entries().find((candidate) => candidate.key === key);
    if (!entry) throw new Error(`no entry ${key} in ${JSON.stringify(form.entries())}`);
    form.choose(entry);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { form, setQuery, notes, close, stepChanged, invoke, paramOptions, choose, settle };
}

describe("plugin command form", () => {
  it("runs a command without params at once", async () => {
    const h = harness();
    h.form.start(command([]));
    expect(h.form.active()).toBe(false);
    expect(h.close).toHaveBeenCalled();
    await h.settle();
    expect(h.invoke).toHaveBeenCalledWith(
      "plugin.tasks.new",
      {},
      { source: "palette", session: "demo", pane: "%3" },
      false,
    );
    expect(h.notes).toEqual(["New task…", "New task: made it"]);
  });

  it("collects text, number, boolean and choice params one step at a time", async () => {
    const h = harness();
    h.form.start(
      command([
        param({ name: "name", label: "Branch name" }),
        param({ name: "count", type: "number", label: "Count" }),
        param({ name: "draft", type: "boolean", label: "Draft", default: false }),
        param({
          name: "agent",
          type: "choice",
          label: "Agent",
          choices: [
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
          ],
        }),
      ]),
    );
    expect(h.form.hint()).toBe("New task · Branch name (1/4) · Enter to choose · Esc to cancel");
    expect(h.form.entries()).toEqual([
      {
        kind: "plugin-form",
        key: "submit",
        label: "Type the branch name",
        detail: "Branch name",
        disabledReason: "Branch name is required",
      },
    ]);
    h.setQuery("fix-login");
    expect(h.form.entries()[0]?.label).toBe("Use “fix-login”");
    h.choose("submit");
    h.setQuery("x2");
    h.choose("submit");
    expect(h.notes.at(-1)).toBe("Count must be a number");
    h.setQuery("2");
    h.choose("submit");
    expect(h.form.entries().map((e) => e.label)).toEqual(["Yes", "No (default)"]);
    h.choose("bool:true");
    expect(h.form.entries().map((e) => e.key)).toEqual(["choice:claude", "choice:codex"]);
    h.choose("choice:codex");
    await h.settle();
    expect(h.invoke).toHaveBeenCalledWith(
      "plugin.tasks.new",
      { name: "fix-login", count: 2, draft: true, agent: "codex" },
      expect.anything(),
      false,
    );
    expect(h.stepChanged).toHaveBeenCalledTimes(4);
    expect(h.form.active()).toBe(false);
  });

  it("uses defaults, skips optional params and asks the plugin for dynamic choices", async () => {
    const h = harness();
    h.form.start(
      command([
        param({ name: "base", label: "Base", default: "main" }),
        param({ name: "note", label: "Note", required: false }),
        param({
          name: "task",
          type: "choice",
          label: "Task",
          dynamicChoices: true,
          dynamicDefault: true,
        }),
      ]),
    );
    expect(h.form.entries()[0]?.label).toBe("Use default “main”");
    h.choose("submit");
    expect(h.form.entries().map((e) => e.key)).toEqual(["submit", "skip"]);
    h.choose("skip");
    expect(h.form.entries()).toEqual([
      expect.objectContaining({ key: "loading", disabledReason: "Still loading choices" }),
    ]);
    await h.settle();
    expect(h.paramOptions).toHaveBeenCalledWith("plugin.tasks.new", "task", expect.anything());
    expect(h.form.entries()).toEqual([
      expect.objectContaining({ key: "choice:a", label: "A (default)" }),
    ]);
    h.choose("choice:a");
    await h.settle();
    expect(h.invoke).toHaveBeenCalledWith(
      "plugin.tasks.new",
      { base: "main", task: "a" },
      expect.anything(),
      false,
    );
  });

  it("ends a dangerous command with a confirm step and sends it confirmed", async () => {
    const h = harness();
    h.form.start(command([], true));
    expect(h.form.active()).toBe(true);
    expect(h.form.entries().map((e) => e.key)).toEqual(["run", "cancel"]);
    h.choose("run");
    await h.settle();
    expect(h.invoke).toHaveBeenCalledWith("plugin.tasks.new", {}, expect.anything(), true);
  });

  it("cancels at the confirm step without invoking", async () => {
    const h = harness();
    h.form.start(command([], true));
    h.choose("cancel");
    await h.settle();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.notes.at(-1)).toBe("New task: cancelled");
  });

  it("reports a plugin error, and ignores late choices after a cancel", async () => {
    let resolveOptions: (value: {
      ok: true;
      choices: { value: string; label: string }[];
    }) => void = () => {};
    const h = harness({
      invoke: async () => ({ ok: false, error: "E_INVALID: 'name' is required" }),
      paramOptions: () =>
        new Promise((resolve) => {
          resolveOptions = resolve;
        }),
    });
    h.form.start(command([param({ name: "task", type: "choice", dynamicChoices: true })]));
    h.form.cancel();
    resolveOptions({ ok: true, choices: [{ value: "late", label: "late" }] });
    await h.settle();
    expect(h.form.active()).toBe(false);
    h.form.start(command([]));
    await h.settle();
    expect(h.notes.at(-1)).toBe("New task: E_INVALID: 'name' is required");
  });

  it("never puts control or bidi characters in notes or the hint", async () => {
    const nasty = "a\u001b[2Jb\u009bc\u202ed\ne";
    const h = harness({ invoke: async () => ({ ok: false as const, error: nasty }) });
    h.form.start({ ...command([]), label: nasty });
    await h.settle();
    const value = harness({ invoke: async () => ({ ok: true as const, value: nasty }) });
    value.form.start(command([]));
    await value.settle();
    const hinted = harness();
    hinted.form.start({ ...command([param({ name: "x", label: nasty })]), label: nasty });
    const shown = [...h.notes, ...value.notes, hinted.form.hint()];
    expect(shown).toHaveLength(5);
    for (const text of shown) expect(hasUnsafeText(text ?? ""), JSON.stringify(text)).toBe(false);
  });

  it("refuses an empty value for a required param, even with an empty default", () => {
    const h = harness();
    h.form.start(command([param({ name: "name", label: "Name", default: "" })]));
    h.choose("submit");
    expect(h.notes.at(-1)).toBe("Name is required");
    expect(h.form.active()).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("palette invocation context", () => {
  it("passes a tmux pane id as ctx.pane and drops anything else", () => {
    expect(pluginPaletteContext("demo", "%12")).toEqual({
      source: "palette",
      session: "demo",
      pane: "%12",
    });
    expect(pluginPaletteContext("demo", "pane.mirror.0a1b2c3d4e5f6a7b")).toEqual({
      source: "palette",
      session: "demo",
    });
    expect(pluginPaletteContext(null, null)).toEqual({ source: "palette" });
  });
});
