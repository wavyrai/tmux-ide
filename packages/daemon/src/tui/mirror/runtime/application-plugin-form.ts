/**
 * The step-by-step form a plugin command with parameters opens inside the
 * palette. Each step is one parameter: the palette's search line is the
 * input, and its list holds the step's entries (a choice per option, or one
 * "Use …" entry for free text). A dangerous command ends with a confirm step.
 *
 * Arguments are checked again by the plugin; this only collects them.
 */
import type {
  CommandInvocationContext,
  CommandInvokeResult,
  CommandParam,
  CommandParamOptionsResult,
} from "@tmux-ide/contracts";
import { createSignal } from "solid-js";
import type {
  ApplicationPluginFormPaletteCommand,
  ApplicationPluginPaletteCommand,
} from "../workspace/application-command-description.ts";

type ArgValue = string | number | boolean;

interface ParamOptionsState {
  readonly phase: "loading" | "ready" | "error";
  readonly choices?: readonly { value: string; label: string }[];
  readonly default?: ArgValue;
  readonly error?: string;
}

interface FormState {
  readonly command: ApplicationPluginPaletteCommand;
  readonly step: number;
  readonly values: Readonly<Record<string, ArgValue>>;
  readonly options: Readonly<Record<string, ParamOptionsState>>;
  readonly generation: number;
}

export interface PluginFormService {
  invoke(
    id: string,
    args: Record<string, ArgValue>,
    context: CommandInvocationContext,
    confirmed: boolean,
  ): Promise<CommandInvokeResult>;
  paramOptions(
    id: string,
    param: string,
    context: CommandInvocationContext,
  ): Promise<CommandParamOptionsResult>;
}

const quote = (value: ArgValue) => (typeof value === "string" ? `“${value}”` : String(value));

function resultNote(label: string, result: CommandInvokeResult): string {
  if (!result.ok) return `${label}: ${result.error}`;
  if (typeof result.value === "string" && result.value.trim()) return `${label}: ${result.value}`;
  return `${label}: done`;
}

/**
 * The context a palette invocation sends. The TUI's focused pane id is its
 * own mirror id, not the tmux `%N` id plugins pass to ide.exec{context}, so
 * only a real tmux pane id is sent as `pane`.
 */
export function pluginPaletteContext(
  session: string | null,
  focusedPane: string | null,
): CommandInvocationContext {
  const pane = focusedPane && /^%\d{1,9}$/u.test(focusedPane) ? focusedPane : null;
  return {
    source: "palette",
    ...(session ? { session } : {}),
    ...(pane ? { pane } : {}),
  };
}

export function createApplicationPluginForm(options: {
  readonly service: PluginFormService;
  readonly context: () => CommandInvocationContext;
  readonly query: () => string;
  readonly setNote: (note: string | null) => void;
  /** Close the palette (the form finished or was cancelled). */
  readonly close: () => void;
  /** A new step started: clear the search line and selection. */
  readonly stepChanged: () => void;
}) {
  const [state, setState] = createSignal<FormState | null>(null);
  let generation = 0;

  const run = (command: ApplicationPluginPaletteCommand, args: Record<string, ArgValue>) => {
    setState(null);
    options.close();
    options.setNote(`${command.label}…`);
    void options.service
      .invoke(command.id, args, options.context(), command.dangerous)
      .then((result) => options.setNote(resultNote(command.label, result)));
  };

  const loadOptions = (current: FormState, param: CommandParam) => {
    if (!param.dynamicChoices && !param.dynamicDefault) return;
    if (current.options[param.name]) return;
    const marker = current.generation;
    setState({ ...current, options: { ...current.options, [param.name]: { phase: "loading" } } });
    void options.service
      .paramOptions(current.command.id, param.name, options.context())
      .then((result) => {
        const latest = state();
        if (!latest || latest.generation !== marker) return;
        setState({
          ...latest,
          options: {
            ...latest.options,
            [param.name]: result.ok
              ? {
                  phase: "ready",
                  ...(result.choices ? { choices: result.choices } : {}),
                  ...(result.default !== undefined ? { default: result.default } : {}),
                }
              : { phase: "error", error: result.error },
          },
        });
      });
  };

  const enterStep = (next: FormState) => {
    const { command } = next;
    if (next.step >= command.params.length) {
      // Past the last parameter: confirm a dangerous command, else run it.
      if (command.dangerous && next.step === command.params.length) {
        setState(next);
        options.stepChanged();
        return;
      }
      run(command, { ...next.values });
      return;
    }
    setState(next);
    options.stepChanged();
    loadOptions(next, command.params[next.step]!);
  };

  const currentParam = (current: FormState): CommandParam | null =>
    current.command.params[current.step] ?? null;

  const defaultFor = (current: FormState, param: CommandParam): ArgValue | undefined =>
    current.options[param.name]?.default ?? param.default;

  const choicesFor = (current: FormState, param: CommandParam) =>
    current.options[param.name]?.choices ?? param.choices ?? [];

  const advance = (current: FormState, param: CommandParam, value: ArgValue | undefined) => {
    const values = { ...current.values };
    if (value === undefined) delete values[param.name];
    else values[param.name] = value;
    enterStep({ ...current, step: current.step + 1, values });
  };

  return {
    active: () => state() !== null,

    /**
     * Start a plugin command. One without parameters and not dangerous runs
     * at once; otherwise the palette turns into its form.
     */
    start(command: ApplicationPluginPaletteCommand): void {
      generation += 1;
      if (command.params.length === 0 && !command.dangerous) {
        run(command, {});
        return;
      }
      enterStep({ command, step: 0, values: {}, options: {}, generation });
    },

    cancel(): void {
      if (!state()) return;
      generation += 1;
      setState(null);
    },

    entries(): ApplicationPluginFormPaletteCommand[] {
      const current = state();
      if (!current) return [];
      const param = currentParam(current);
      if (!param) {
        return [
          {
            kind: "plugin-form",
            key: "run",
            label: `Run ${current.command.label}`,
            detail: "This cannot be undone",
          },
          { kind: "plugin-form", key: "cancel", label: "Cancel", detail: "Do nothing" },
        ];
      }
      const detail = param.description ?? param.label;
      const loaded = current.options[param.name];
      const out: ApplicationPluginFormPaletteCommand[] = [];
      if (loaded?.phase === "loading") {
        out.push({
          kind: "plugin-form",
          key: "loading",
          label: "Loading choices…",
          detail,
          disabledReason: "Still loading choices",
        });
        return out;
      }
      if (loaded?.phase === "error") {
        out.push({
          kind: "plugin-form",
          key: "error",
          label: loaded.error ?? "Choices are unavailable",
          detail,
          disabledReason: "The plugin could not list choices",
        });
      }
      const fallback = defaultFor(current, param);
      if (param.type === "choice") {
        for (const choice of choicesFor(current, param)) {
          out.push({
            kind: "plugin-form",
            key: `choice:${choice.value}`,
            label: choice.value === fallback ? `${choice.label} (default)` : choice.label,
            detail,
          });
        }
      } else if (param.type === "boolean") {
        for (const value of [true, false]) {
          out.push({
            kind: "plugin-form",
            key: `bool:${value}`,
            label: `${value ? "Yes" : "No"}${fallback === value ? " (default)" : ""}`,
            detail,
          });
        }
      } else {
        const typed = options.query();
        out.push({
          kind: "plugin-form",
          key: "submit",
          label: typed
            ? `Use ${quote(typed)}`
            : fallback !== undefined
              ? `Use default ${quote(fallback)}`
              : `Type the ${param.label.toLowerCase()}`,
          detail,
          ...(!typed && fallback === undefined && param.required
            ? { disabledReason: `${param.label} is required` }
            : {}),
        });
      }
      if (!param.required)
        out.push({ kind: "plugin-form", key: "skip", label: "Leave empty", detail });
      return out;
    },

    /** The person activated one of the current step's entries. */
    choose(entry: ApplicationPluginFormPaletteCommand): void {
      const current = state();
      if (!current) return;
      const param = currentParam(current);
      if (!param) {
        if (entry.key === "run") run(current.command, { ...current.values });
        else {
          setState(null);
          options.close();
          options.setNote(`${current.command.label}: cancelled`);
        }
        return;
      }
      if (entry.key === "skip") return advance(current, param, undefined);
      if (entry.key.startsWith("choice:")) return advance(current, param, entry.key.slice(7));
      if (entry.key.startsWith("bool:")) return advance(current, param, entry.key === "bool:true");
      if (entry.key !== "submit") return;
      const typed = options.query();
      const raw: ArgValue | undefined = typed || defaultFor(current, param);
      if (raw === undefined || raw === "") {
        options.setNote(`${param.label} is required`);
        return;
      }
      if (param.type === "number") {
        const number = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(number) || (typeof raw === "string" && raw.trim() === "")) {
          options.setNote(`${param.label} must be a number`);
          return;
        }
        return advance(current, param, number);
      }
      advance(current, param, String(raw));
    },

    /** Keyboard hint while the form is open. */
    hint(): string {
      const current = state();
      if (!current) return "";
      const param = currentParam(current);
      const total = current.command.params.length;
      return param
        ? `${current.command.label} · ${param.label} (${current.step + 1}/${total}) · Enter to choose · Esc to cancel`
        : `${current.command.label} · confirm · Enter to choose · Esc to cancel`;
    },
  };
}

export type ApplicationPluginForm = ReturnType<typeof createApplicationPluginForm>;
