/**
 * Monaco TypeScript / JavaScript language defaults.
 *
 * Mirrors emdash's `monaco-config.ts` semantically: semantic
 * validation is OFF (Monaco doesn't have the full tsconfig
 * environment here — semantic errors are misleading) but syntax
 * validation stays on so brace / paren / token-level mistakes still
 * light up.
 *
 * `monaco.languages.typescript` is marked deprecated in the public
 * 0.55 types (the namespace is preserved at runtime but the type
 * surface was stripped), so we access it via the runtime-only handle
 * loaded by `@monaco-editor/loader`. The defensive `try/catch`
 * mirrors the original — if the language service is unavailable in
 * a stripped build, the editor still works (just without TS
 * suggestions).
 */

import type * as monaco from "monaco-editor";

// Runtime-only shape — Monaco's `languages.typescript` namespace ships
// at runtime but is missing from the published .d.ts in 0.55+. Cast
// once here so the rest of the file stays typed.
interface TypeScriptLanguageRuntime {
  typescriptDefaults: {
    setCompilerOptions(opts: Record<string, unknown>): void;
    setDiagnosticsOptions(opts: Record<string, unknown>): void;
    setEagerModelSync(value: boolean): void;
  };
  javascriptDefaults: TypeScriptLanguageRuntime["typescriptDefaults"];
  ScriptTarget: Record<string, number>;
  ModuleKind: Record<string, number>;
  ModuleResolutionKind: Record<string, number>;
  JsxEmit: Record<string, number>;
}

function readTsRuntime(m: typeof monaco): TypeScriptLanguageRuntime | null {
  const raw = (m.languages as unknown as { typescript?: TypeScriptLanguageRuntime }).typescript;
  if (!raw || typeof raw !== "object") return null;
  if (!("typescriptDefaults" in raw)) return null;
  return raw;
}

const DIAGNOSTICS_OPTIONS = {
  noSemanticValidation: true,
  noSyntaxValidation: false,
};

export function configureMonacoTypeScript(monacoInstance: typeof monaco): void {
  try {
    const ts = readTsRuntime(monacoInstance);
    if (!ts) {
      console.warn("[monaco] TypeScript language service not present; skipping defaults.");
      return;
    }
    configureTypeScriptDefaults(ts);
    configureJavaScriptDefaults(ts);
  } catch (error) {
    console.warn("[monaco] Failed to configure TypeScript settings:", error);
  }
}

function configureTypeScriptDefaults(ts: TypeScriptLanguageRuntime): void {
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    lib: ["es2020", "dom", "dom.iterable"],
    allowJs: false,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: true,
    forceConsistentCasingInFileNames: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
    typeRoots: ["./node_modules/@types"],
  });
  ts.typescriptDefaults.setDiagnosticsOptions(DIAGNOSTICS_OPTIONS);
  ts.typescriptDefaults.setEagerModelSync(true);
}

function configureJavaScriptDefaults(ts: TypeScriptLanguageRuntime): void {
  ts.javascriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    lib: ["es2020", "dom", "dom.iterable"],
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  });
  ts.javascriptDefaults.setDiagnosticsOptions(DIAGNOSTICS_OPTIONS);
  ts.javascriptDefaults.setEagerModelSync(true);
}

/**
 * Per-instance editor option tweaks. Called after `editor.create` so
 * the global defaults stay terse.
 */
export function configureMonacoEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
  editor.updateOptions({
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    parameterHints: { enabled: true },
    wordBasedSuggestions: "off",
    suggest: {
      showKeywords: true,
      showSnippets: true,
      showClasses: true,
      showFunctions: true,
      showVariables: true,
    },
  });
}

/**
 * Install Cmd/Ctrl+S → onSave keybinds on a single editor instance.
 */
export function addMonacoKeyboardShortcuts(
  editor: monaco.editor.IStandaloneCodeEditor,
  m: typeof monaco,
  handlers: { onSave?: () => void; onSaveAll?: () => void },
): void {
  if (handlers.onSave) {
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, handlers.onSave);
  }
  if (handlers.onSaveAll) {
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyS, handlers.onSaveAll);
  }
}
