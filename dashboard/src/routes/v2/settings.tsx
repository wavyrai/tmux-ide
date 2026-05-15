/**
 * /v2/settings — Solid port of `dashboard/app/v2/settings/page.tsx`.
 *
 * Five-tab layout (Theme / Terminal / Sounds / General / Keybinds).
 * Active tab is persisted to localStorage so reloads land on the same
 * surface. Every form reads + writes via the shared `settings` signal
 * (see `lib/settings.ts`) — no per-panel state.
 */

import { createSignal, For, type Component, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Bell, Keyboard, Palette, SlidersHorizontal, Terminal as TerminalIcon } from "lucide-solid";
import {
  resetKeybind,
  setGeneral,
  setKeybindOverride,
  setNotification,
  setSound,
  setTerminal,
  setThemeId,
  settings,
  type ThemeId,
} from "@/lib/settings";

type TabId = "theme" | "terminal" | "sounds" | "general" | "keybinds";
type IconComponent = Component<{ size?: number; strokeWidth?: number; class?: string }>;

const TABS: ReadonlyArray<{ id: TabId; label: string; Icon: IconComponent }> = [
  { id: "theme", label: "Theme", Icon: Palette },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "sounds", label: "Sounds", Icon: Bell },
  { id: "general", label: "General", Icon: SlidersHorizontal },
  { id: "keybinds", label: "Keybinds", Icon: Keyboard },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.id));
const TAB_STORAGE_KEY = "tmux-ide.settings.active-tab";

function readInitialTab(): TabId {
  if (typeof window === "undefined") return "theme";
  try {
    const raw = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (raw && VALID_TABS.has(raw)) return raw as TabId;
  } catch {
    /* ignore */
  }
  return "theme";
}

function persistTab(tab: TabId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* ignore */
  }
}

export default function SettingsRoute() {
  const [tab, setTab] = createSignal<TabId>(readInitialTab());

  function pick(next: TabId) {
    setTab(next);
    persistTab(next);
  }

  return (
    <div
      data-testid="settings-page"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header
        data-testid="settings-page-header"
        class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-4 py-3 text-[12px]"
      >
        <SlidersHorizontal size={16} class="text-[var(--accent)]" aria-hidden="true" />
        <h1 class="text-[13px] font-medium text-[var(--fg)]">Settings</h1>
        <span class="flex-1" />
        <A
          href="/v2"
          class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          ← Back to v2
        </A>
      </header>

      <div class="flex flex-1 min-h-0">
        <nav
          aria-label="Settings sections"
          data-testid="settings-page-tabs"
          class="flex w-44 shrink-0 flex-col gap-px border-r border-[var(--border)] bg-[var(--bg-weak)] p-2 text-[12px]"
        >
          <For each={TABS}>
            {(spec) => {
              const active = () => tab() === spec.id;
              return (
                <button
                  type="button"
                  data-testid={`settings-tab-${spec.id}`}
                  data-active={active() ? "true" : undefined}
                  onClick={() => pick(spec.id)}
                  class={
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors " +
                    (active()
                      ? "bg-[var(--surface-active)] text-[var(--accent)]"
                      : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]")
                  }
                >
                  <spec.Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{spec.label}</span>
                </button>
              );
            }}
          </For>
        </nav>

        <section
          data-testid="settings-page-body"
          class="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          {tab() === "theme" && <ThemePanel />}
          {tab() === "terminal" && <TerminalPanel />}
          {tab() === "sounds" && <SoundsPanel />}
          {tab() === "general" && <GeneralPanel />}
          {tab() === "keybinds" && <KeybindsPanel />}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Theme panel
// ---------------------------------------------------------------------

const THEMES: ReadonlyArray<{ id: ThemeId; label: string; hint: string }> = [
  { id: "dark", label: "Dark", hint: "Default dark · #101010" },
  { id: "light", label: "Light", hint: "High-contrast light" },
  { id: "catppuccin", label: "Catppuccin", hint: "Mocha · soft lavender accents" },
  { id: "dracula", label: "Dracula", hint: "Purple + cyan classic" },
  { id: "tokyonight", label: "Tokyo Night", hint: "Cool blue · low chroma" },
  { id: "solarized-dark", label: "Solarized Dark", hint: "Beige-on-cyan" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", hint: "Warm earthen palette" },
  { id: "gruvbox-light", label: "Gruvbox Light", hint: "Same palette, inverted" },
];

function ThemePanel() {
  return (
    <PanelShell title="Theme" description="Color scheme for the dashboard.">
      <div
        data-testid="settings-theme-grid"
        class="grid gap-2"
        style={{ "grid-template-columns": "repeat(auto-fill, minmax(200px, 1fr))" }}
      >
        <For each={THEMES}>
          {(t) => {
            const active = () => settings().themeId === t.id;
            return (
              <button
                type="button"
                data-testid={`settings-theme-${t.id}`}
                data-active={active() ? "true" : undefined}
                onClick={() => setThemeId(t.id)}
                class={
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors " +
                  (active()
                    ? "border-[var(--accent)] bg-[var(--surface-active)]"
                    : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]")
                }
              >
                <span class="text-[13px] font-medium text-[var(--fg)]">{t.label}</span>
                <span class="text-[11px] text-[var(--dim)]">{t.hint}</span>
              </button>
            );
          }}
        </For>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------

function TerminalPanel() {
  return (
    <PanelShell title="Terminal" description="Embedded xterm rendering preferences.">
      <FieldRow label="Font size" hint="Pixels. Affects the embedded xterm only.">
        <input
          type="number"
          min={8}
          max={32}
          step={1}
          data-testid="settings-terminal-font-size"
          value={settings().terminal.fontSize}
          onInput={(e) => {
            const next = Number.parseInt(e.currentTarget.value, 10);
            if (Number.isFinite(next)) setTerminal({ fontSize: next });
          }}
          class="h-7 w-20 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow
        label="Font family"
        hint="Monospace stack for the terminal. Empty = dashboard default."
      >
        <input
          type="text"
          placeholder='ui-monospace, "JetBrains Mono", Menlo, monospace'
          data-testid="settings-terminal-font-family"
          value={settings().terminal.fontFamily}
          onInput={(e) => setTerminal({ fontFamily: e.currentTarget.value })}
          class="h-7 w-72 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-[11px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow label="Scrollback" hint="Lines kept in each buffer. Takes effect on new sessions.">
        <input
          type="number"
          min={1000}
          max={100000}
          step={500}
          data-testid="settings-terminal-scrollback"
          value={settings().terminal.scrollback}
          onInput={(e) => {
            const next = Number.parseInt(e.currentTarget.value, 10);
            if (Number.isFinite(next)) setTerminal({ scrollback: next });
          }}
          class="h-7 w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow label="Cursor blink" hint="Whether the terminal cursor blinks when idle.">
        <Toggle
          data-testid="settings-terminal-cursor-blink"
          checked={settings().terminal.cursorBlink}
          onChange={(value) => setTerminal({ cursorBlink: value })}
        />
      </FieldRow>
      <FieldRow
        label="Renderer"
        hint="Auto/WebGL accelerate; DOM disables WebGL. Applies to new sessions."
      >
        <select
          data-testid="settings-terminal-renderer"
          value={settings().terminal.renderer}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === "auto" || next === "webgl" || next === "dom") {
              setTerminal({ renderer: next });
            }
          }}
          class="h-7 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        >
          <option value="auto">Auto</option>
          <option value="webgl">WebGL</option>
          <option value="dom">DOM</option>
        </select>
      </FieldRow>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Sounds panel
// ---------------------------------------------------------------------

function requestBannerPermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") void Notification.requestPermission();
}

function SoundsPanel() {
  return (
    <>
      <PanelShell
        title="Chat notifications"
        description="Alerts when an assistant turn finishes while the window is in the background."
      >
        <FieldRow
          label="Play sound"
          hint="Short chime when a reply lands and the window is unfocused."
        >
          <Toggle
            data-testid="settings-notification-sound"
            checked={settings().notification.sound}
            onChange={(value) => setNotification({ sound: value })}
          />
        </FieldRow>
        <FieldRow
          label="Desktop banners"
          hint="OS notification via the browser Notification API. Asks for permission on enable."
        >
          <Toggle
            data-testid="settings-notification-desktop-banners"
            checked={settings().notification.desktopBanners}
            onChange={(value) => {
              if (value) requestBannerPermission();
              setNotification({ desktopBanners: value });
            }}
          />
        </FieldRow>
      </PanelShell>
      <PanelShell title="Sounds" description="Audio notifications. Off by default.">
        <FieldRow label="Task complete">
          <Toggle
            data-testid="settings-sound-task-complete"
            checked={settings().sounds.onTaskComplete}
            onChange={(value) => setSound("onTaskComplete", value)}
          />
        </FieldRow>
        <FieldRow label="Task error">
          <Toggle
            data-testid="settings-sound-task-error"
            checked={settings().sounds.onTaskError}
            onChange={(value) => setSound("onTaskError", value)}
          />
        </FieldRow>
        <FieldRow label="Agent idle">
          <Toggle
            data-testid="settings-sound-agent-idle"
            checked={settings().sounds.onAgentIdle}
            onChange={(value) => setSound("onAgentIdle", value)}
          />
        </FieldRow>
      </PanelShell>
    </>
  );
}

// ---------------------------------------------------------------------
// General panel
// ---------------------------------------------------------------------

const PROJECT_TABS = [
  "kanban",
  "mission",
  "diffs",
  "plans",
  "validation",
  "metrics",
  "activity",
] as const;

function GeneralPanel() {
  return (
    <PanelShell title="General" description="Default routes and project bootstrap.">
      <FieldRow label="Default project tab" hint="Which view opens when entering a project.">
        <select
          data-testid="settings-general-default-project-tab"
          value={settings().general.defaultProjectTab}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if ((PROJECT_TABS as ReadonlyArray<string>).includes(next)) {
              setGeneral({ defaultProjectTab: next as (typeof PROJECT_TABS)[number] });
            }
          }}
          class="h-7 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        >
          <For each={PROJECT_TABS}>{(v) => <option value={v}>{v}</option>}</For>
        </select>
      </FieldRow>
      <FieldRow
        label="Add-project base directory"
        hint="Default starting path in the new-project picker."
      >
        <input
          type="text"
          data-testid="settings-general-base-directory"
          value={settings().general.addProjectBaseDirectory}
          onInput={(e) => setGeneral({ addProjectBaseDirectory: e.currentTarget.value })}
          class="h-7 w-72 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow label="Show notifications" hint="Browser notifications on milestone events.">
        <Toggle
          data-testid="settings-general-show-notifications"
          checked={settings().general.showNotifications}
          onChange={(value) => setGeneral({ showNotifications: value })}
        />
      </FieldRow>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Keybinds panel
// ---------------------------------------------------------------------

const KEYBIND_DEFAULTS = [
  { id: "openCommandPalette", label: "Open command palette", defaultKey: "⌘K" },
  { id: "toggleLeftSidebar", label: "Toggle left sidebar", defaultKey: "⌘B" },
  { id: "toggleRightInspector", label: "Toggle right inspector", defaultKey: "⌘⌥B" },
  { id: "toggleBottomPanel", label: "Toggle bottom panel", defaultKey: "⌘J" },
  { id: "toggleSendOnEnter", label: "Send / new line", defaultKey: "Enter" },
];

function KeybindsPanel() {
  return (
    <PanelShell
      title="Keybinds"
      description="Override shortcuts. Empty = use the default. Reset returns to factory."
    >
      <table class="w-full text-[12px]">
        <thead class="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
          <tr>
            <th class="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Action</th>
            <th class="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Default</th>
            <th class="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Override</th>
            <th class="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Reset</th>
          </tr>
        </thead>
        <tbody>
          <For each={KEYBIND_DEFAULTS}>
            {(bind) => {
              const override = () => settings().keybinds[bind.id] ?? "";
              return (
                <tr data-testid={`settings-keybind-row-${bind.id}`}>
                  <td class="py-2 pr-3 text-[var(--fg)]">{bind.label}</td>
                  <td class="py-2 pr-3 font-mono text-[var(--fg-secondary)]">{bind.defaultKey}</td>
                  <td class="py-2 pr-3">
                    <input
                      type="text"
                      data-testid={`settings-keybind-input-${bind.id}`}
                      placeholder={bind.defaultKey}
                      value={override()}
                      onInput={(e) => setKeybindOverride(bind.id, e.currentTarget.value.trim())}
                      class="h-7 w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                    />
                  </td>
                  <td class="py-2 pr-3">
                    <button
                      type="button"
                      data-testid={`settings-keybind-reset-${bind.id}`}
                      onClick={() => resetKeybind(bind.id)}
                      disabled={!override()}
                      class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <button
        type="button"
        data-testid="settings-keybinds-reset-all"
        onClick={() => {
          for (const bind of KEYBIND_DEFAULTS) resetKeybind(bind.id);
        }}
        class="self-start rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        Reset all
      </button>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

function PanelShell(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <article class="flex max-w-3xl flex-col gap-4">
      <header>
        <h2 class="text-[14px] font-medium text-[var(--fg)]">{props.title}</h2>
        <p class="mt-0.5 text-[11px] text-[var(--dim)]">{props.description}</p>
      </header>
      <div class="flex flex-col gap-3">{props.children}</div>
    </article>
  );
}

function FieldRow(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <label class="flex flex-wrap items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-[12px] text-[var(--fg)]">{props.label}</span>
        {props.hint && <span class="text-[10px] text-[var(--dim)]">{props.hint}</span>}
      </span>
      <span class="flex items-center">{props.children}</span>
    </label>
  );
}

function Toggle(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      data-testid={props["data-testid"]}
      onClick={() => props.onChange(!props.checked)}
      class={
        "relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full border transition-colors " +
        (props.checked
          ? "border-[var(--accent)] bg-[var(--accent)]"
          : "border-[var(--border)] bg-[var(--surface)]")
      }
    >
      <span
        aria-hidden="true"
        class="absolute h-3 w-3 rounded-full bg-[var(--bg)] transition-transform"
        style={{ transform: props.checked ? "translateX(20px)" : "translateX(4px)" }}
      />
    </button>
  );
}
