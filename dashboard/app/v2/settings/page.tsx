"use client";

/**
 * /v2/settings — user-level preferences page.
 *
 * Five-tab layout (Theme / Terminal / Sounds / General / Keybinds),
 * with the active tab persisted in localStorage so reloading or
 * deep-linking to /v2/settings lands on the user's last surface.
 *
 * Every form on this page reads + writes via `useSettings`. That hook
 * already owns the `Persist.global` store and broadcasts changes — no
 * local form state needed. Theme changes apply immediately (the
 * theme module's `applyTheme` cascades on every patch).
 *
 * Out of scope: ide.yml editing. Project-level config lives at
 * `/v2/project/<name>` → the existing Settings widget. This page is
 * for dashboard-wide preferences.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Keyboard,
  Palette,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useSettings, type ThemeId } from "@/lib/useSettings";

type TabId = "theme" | "terminal" | "sounds" | "general" | "keybinds";

const TAB_STORAGE_KEY = "tmux-ide.settings.active-tab";

interface TabSpec {
  id: TabId;
  label: string;
  Icon: LucideIcon;
}

const TABS: readonly TabSpec[] = [
  { id: "theme", label: "Theme", Icon: Palette },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "sounds", label: "Sounds", Icon: Bell },
  { id: "general", label: "General", Icon: SlidersHorizontal },
  { id: "keybinds", label: "Keybinds", Icon: Keyboard },
] as const;

const VALID_TABS = new Set<string>(TABS.map((t) => t.id));

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

export default function SettingsPage() {
  const [tab, setTab] = useState<TabId>(readInitialTab);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  return (
    <div
      data-testid="settings-page"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header
        data-testid="settings-page-header"
        className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-4 py-3 text-[12px]"
      >
        <SlidersHorizontal size={16} className="text-[var(--accent)]" aria-hidden="true" />
        <h1 className="text-[13px] font-medium text-[var(--fg)]">Settings</h1>
        <span className="flex-1" />
        <Link
          href="/v2"
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          ← Back to v2
        </Link>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav
          aria-label="Settings sections"
          data-testid="settings-page-tabs"
          className="flex w-44 shrink-0 flex-col gap-px border-r border-[var(--border)] bg-[var(--bg-weak)] p-2 text-[12px]"
        >
          {TABS.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`settings-tab-${id}`}
                data-active={active ? "true" : undefined}
                onClick={() => setTab(id)}
                className={
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors " +
                  (active
                    ? "bg-[var(--surface-active)] text-[var(--accent)]"
                    : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]")
                }
              >
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <section
          data-testid="settings-page-body"
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          {tab === "theme" && <ThemePanel />}
          {tab === "terminal" && <TerminalPanel />}
          {tab === "sounds" && <SoundsPanel />}
          {tab === "general" && <GeneralPanel />}
          {tab === "keybinds" && <KeybindsPanel />}
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
  const { themeId, setThemeId } = useSettings();
  return (
    <PanelShell title="Theme" description="Color scheme for the dashboard.">
      <div
        data-testid="settings-theme-grid"
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
      >
        {THEMES.map((t) => {
          const active = themeId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`settings-theme-${t.id}`}
              data-active={active ? "true" : undefined}
              onClick={() => setThemeId(t.id)}
              className={
                "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors " +
                (active
                  ? "border-[var(--accent)] bg-[var(--surface-active)]"
                  : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]")
              }
            >
              <span className="text-[13px] font-medium text-[var(--fg)]">{t.label}</span>
              <span className="text-[11px] text-[var(--dim)]">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------

function TerminalPanel() {
  const { terminal, setTerminal } = useSettings();
  return (
    <PanelShell title="Terminal" description="Embedded xterm rendering preferences.">
      <FieldRow
        label="Font size"
        hint="Pixels. Affects the embedded xterm only — dashboard chrome is fixed."
      >
        <input
          type="number"
          min={8}
          max={32}
          step={1}
          data-testid="settings-terminal-font-size"
          value={terminal.fontSize}
          onChange={(e) => {
            const next = Number.parseInt(e.currentTarget.value, 10);
            if (Number.isFinite(next)) setTerminal({ fontSize: next });
          }}
          className="h-7 w-20 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow
        label="Scrollback"
        hint="Lines retained in each terminal buffer. Higher = more memory."
      >
        <input
          type="number"
          min={1000}
          max={100000}
          step={500}
          data-testid="settings-terminal-scrollback"
          value={terminal.scrollback}
          onChange={(e) => {
            const next = Number.parseInt(e.currentTarget.value, 10);
            if (Number.isFinite(next)) setTerminal({ scrollback: next });
          }}
          className="h-7 w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow label="Cursor blink" hint="Whether the terminal cursor blinks when idle.">
        <Toggle
          data-testid="settings-terminal-cursor-blink"
          checked={terminal.cursorBlink}
          onChange={(value) => setTerminal({ cursorBlink: value })}
        />
      </FieldRow>
      <FieldRow
        label="Renderer"
        hint="Auto picks WebGL on desktop and DOM on iOS/iPadOS Safari (atlas issues)."
      >
        <select
          data-testid="settings-terminal-renderer"
          value={terminal.renderer}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === "auto" || next === "webgl" || next === "dom") {
              setTerminal({ renderer: next });
            }
          }}
          className="h-7 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
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

function SoundsPanel() {
  const { sounds, setSound } = useSettings();
  return (
    <PanelShell title="Sounds" description="Audio notifications. Off by default.">
      <FieldRow label="Task complete">
        <Toggle
          data-testid="settings-sound-task-complete"
          checked={sounds.onTaskComplete}
          onChange={(value) => setSound("onTaskComplete", value)}
        />
      </FieldRow>
      <FieldRow label="Task error">
        <Toggle
          data-testid="settings-sound-task-error"
          checked={sounds.onTaskError}
          onChange={(value) => setSound("onTaskError", value)}
        />
      </FieldRow>
      <FieldRow label="Agent idle">
        <Toggle
          data-testid="settings-sound-agent-idle"
          checked={sounds.onAgentIdle}
          onChange={(value) => setSound("onAgentIdle", value)}
        />
      </FieldRow>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// General panel
// ---------------------------------------------------------------------

function GeneralPanel() {
  const { general, setGeneral } = useSettings();
  return (
    <PanelShell title="General" description="Default routes and project bootstrap.">
      <FieldRow
        label="Default project tab"
        hint="Which view opens when entering a project. Overrides the URL default."
      >
        <select
          data-testid="settings-general-default-project-tab"
          value={general.defaultProjectTab}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setGeneral({
              defaultProjectTab: next as typeof general.defaultProjectTab,
            });
          }}
          className="h-7 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        >
          {(["kanban", "mission", "diffs", "plans", "validation", "metrics", "activity"] as const).map(
            (v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ),
          )}
        </select>
      </FieldRow>
      <FieldRow
        label="Add-project base directory"
        hint="Default starting path in the new-project picker."
      >
        <input
          type="text"
          data-testid="settings-general-base-directory"
          value={general.addProjectBaseDirectory}
          onChange={(e) => setGeneral({ addProjectBaseDirectory: e.currentTarget.value })}
          className="h-7 w-72 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </FieldRow>
      <FieldRow label="Show notifications" hint="Browser notifications on milestone events.">
        <Toggle
          data-testid="settings-general-show-notifications"
          checked={general.showNotifications}
          onChange={(value) => setGeneral({ showNotifications: value })}
        />
      </FieldRow>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Keybinds panel
// ---------------------------------------------------------------------

interface KeybindSpec {
  id: string;
  label: string;
  defaultKey: string;
}

const KEYBIND_DEFAULTS: ReadonlyArray<KeybindSpec> = [
  { id: "openCommandPalette", label: "Open command palette", defaultKey: "⌘K" },
  { id: "toggleLeftSidebar", label: "Toggle left sidebar", defaultKey: "⌘B" },
  { id: "toggleRightInspector", label: "Toggle right inspector", defaultKey: "⌘⌥B" },
  { id: "toggleBottomPanel", label: "Toggle bottom panel", defaultKey: "⌘J" },
  { id: "toggleSendOnEnter", label: "Send / new line", defaultKey: "Enter" },
];

function KeybindsPanel() {
  const settings = useSettings();
  return (
    <PanelShell
      title="Keybinds"
      description="Override shortcuts. Empty = use the default. Reset returns to factory."
    >
      <table className="w-full text-[12px]">
        <thead className="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
          <tr>
            <th className="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Action</th>
            <th className="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Default</th>
            <th className="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Override</th>
            <th className="border-b border-[var(--border)] pb-1.5 pr-3 text-left">Reset</th>
          </tr>
        </thead>
        <tbody>
          {KEYBIND_DEFAULTS.map((bind) => {
            const override = settings.keybinds[bind.id] ?? "";
            return (
              <tr key={bind.id} data-testid={`settings-keybind-row-${bind.id}`}>
                <td className="py-2 pr-3 text-[var(--fg)]">{bind.label}</td>
                <td className="py-2 pr-3 font-mono text-[var(--fg-secondary)]">
                  {bind.defaultKey}
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="text"
                    data-testid={`settings-keybind-input-${bind.id}`}
                    placeholder={bind.defaultKey}
                    value={override}
                    onChange={(e) =>
                      settings.setKeybindOverride(bind.id, e.currentTarget.value.trim())
                    }
                    className="h-7 w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                  />
                </td>
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    data-testid={`settings-keybind-reset-${bind.id}`}
                    onClick={() => settings.resetKeybind(bind.id)}
                    disabled={!override}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Reset
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        type="button"
        data-testid="settings-keybinds-reset-all"
        onClick={() => {
          for (const bind of KEYBIND_DEFAULTS) settings.resetKeybind(bind.id);
        }}
        className="self-start rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        Reset all
      </button>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Primitives — kept inline so the Settings page doesn't pull in
// dashboard/components/v2-primitives (some are SSR-fragile).
// ---------------------------------------------------------------------

function PanelShell(props: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <article className="flex max-w-3xl flex-col gap-4">
      <header>
        <h2 className="text-[14px] font-medium text-[var(--fg)]">{props.title}</h2>
        <p className="mt-0.5 text-[11px] text-[var(--dim)]">{props.description}</p>
      </header>
      <div className="flex flex-col gap-3">{props.children}</div>
    </article>
  );
}

function FieldRow(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] text-[var(--fg)]">{props.label}</span>
        {props.hint && <span className="text-[10px] text-[var(--dim)]">{props.hint}</span>}
      </span>
      <span className="flex items-center">{props.children}</span>
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
      className={
        "relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full border transition-colors " +
        (props.checked
          ? "border-[var(--accent)] bg-[var(--accent)]"
          : "border-[var(--border)] bg-[var(--surface)]")
      }
    >
      <span
        aria-hidden="true"
        className="absolute h-3 w-3 rounded-full bg-[var(--bg)] transition-transform"
        style={{ transform: props.checked ? "translateX(20px)" : "translateX(4px)" }}
      />
    </button>
  );
}

// Force-reference unused-import sentinel so lints don't complain when
// future panels arrive.
void useMemo;
