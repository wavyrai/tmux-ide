"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { useActions } from "@/lib/actions";
import { playSound, type SoundKind } from "@/lib/sounds";
import { type ThemeId, useSettings } from "@/lib/useSettings";
import { Panel, SectionHeader, SurfaceCard } from "@/components/ui";

type SectionId = "general" | "appearance" | "keybinds" | "terminal" | "sounds" | "about";

const sections: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "keybinds", label: "Keybinds" },
  { id: "terminal", label: "Terminal" },
  { id: "sounds", label: "Sounds" },
  { id: "about", label: "About" },
];

const themes: { id: ThemeId; label: string; colors: string[] }[] = [
  { id: "dark", label: "Dark", colors: ["#101010", "#fab283", "#9bcd97"] },
  { id: "light", label: "Light", colors: ["#fafafa", "#2563eb", "#16a34a"] },
  { id: "catppuccin", label: "Catppuccin Mocha", colors: ["#1e1e2e", "#cba6f7", "#a6e3a1"] },
  { id: "dracula", label: "Dracula", colors: ["#282a36", "#bd93f9", "#50fa7b"] },
  { id: "tokyonight", label: "Tokyonight", colors: ["#1a1b26", "#7aa2f7", "#9ece6a"] },
  { id: "solarized-dark", label: "Solarized Dark", colors: ["#002b36", "#268bd2", "#859900"] },
  { id: "gruvbox-dark", label: "Gruvbox Dark", colors: ["#282828", "#fabd2f", "#b8bb26"] },
  { id: "gruvbox-light", label: "Gruvbox Light", colors: ["#fbf1c7", "#b57614", "#79740e"] },
];

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Escape") return "Escape";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function captureKeybind(event: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-[var(--border-weak)] py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--fg)]">{title}</div>
        {description && <div className="mt-0.5 text-[11px] text-[var(--dim)]">{description}</div>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={`h-5 w-9 rounded-md border transition-colors ${
        checked
          ? "border-[var(--accent)] bg-[var(--accent)]"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      <span
        className={`block h-4 w-4 rounded-md bg-[var(--bg)] transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function SettingsView() {
  const [active, setActive] = useState<SectionId>("general");
  const [editingAction, setEditingAction] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const settings = useSettings();
  const actions = useActions();
  const { setTheme } = useTheme();

  const actionByKeybind = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const action of actions) {
      const keybind = settings.keybinds[action.id] ?? action.keybind;
      if (!keybind || keybind === "none") continue;
      map.set(keybind.toLowerCase(), [...(map.get(keybind.toLowerCase()) ?? []), action.id]);
    }
    return map;
  }, [actions, settings.keybinds]);

  useEffect(() => {
    if (!editingAction) return;
    const onKeydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setEditingAction(null);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        settings.setKeybindOverride(editingAction, "none");
        setEditingAction(null);
        return;
      }
      const next = captureKeybind(event);
      if (!next) return;
      const conflicts = (actionByKeybind.get(next.toLowerCase()) ?? []).filter(
        (id) => id !== editingAction,
      );
      setConflict(conflicts.length > 0 ? `Conflicts with ${conflicts.join(", ")}` : null);
      settings.setKeybindOverride(editingAction, next);
      setEditingAction(null);
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    return () => document.removeEventListener("keydown", onKeydown, { capture: true });
  }, [actionByKeybind, editingAction, settings]);

  function applyTheme(themeId: ThemeId) {
    settings.setThemeId(themeId);
    setTheme(themeId);
  }

  return (
    <Panel testId="settings-view">
      <div className="flex min-h-0 flex-1">
        <nav className="w-52 shrink-0 border-r border-[var(--border-weak)] bg-[var(--bg-strong)] p-2">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              data-testid={`settings-nav-${section.id}`}
              data-active={active === section.id ? "true" : "false"}
              onClick={() => setActive(section.id)}
              className={`block h-8 w-full rounded-md px-2 text-left text-[12px] transition-colors ${
                active === section.id
                  ? "bg-[var(--surface-active)] text-[var(--accent)]"
                  : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
              }`}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 space-y-5 overflow-auto p-4">
          {active === "general" && (
            <section data-testid="settings-section-general" className="max-w-3xl">
              <SectionHeader label="General" />
              <SurfaceCard className="mt-3">
                <SettingRow
                  title="Default activity"
                  description="Sidebar mode selected for new windows."
                >
                  <select
                    value={settings.general.defaultActivity}
                    onChange={(event) =>
                      settings.setGeneral({
                        defaultActivity: event.target
                          .value as typeof settings.general.defaultActivity,
                      })
                    }
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px]"
                  >
                    <option value="sessions">Sessions</option>
                    <option value="skills">Skills</option>
                    <option value="settings">Settings</option>
                  </select>
                </SettingRow>
                <SettingRow
                  title="Default project tab"
                  description="Initial project view preference."
                >
                  <select
                    value={settings.general.defaultProjectTab}
                    onChange={(event) =>
                      settings.setGeneral({
                        defaultProjectTab: event.target
                          .value as typeof settings.general.defaultProjectTab,
                      })
                    }
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px]"
                  >
                    {[
                      "kanban",
                      "mission",
                      "diffs",
                      "plans",
                      "validation",
                      "metrics",
                      "activity",
                    ].map((tab) => (
                      <option key={tab} value={tab}>
                        {tab}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow
                  title="Show notifications"
                  description="Store event bridge history locally."
                >
                  <Toggle
                    checked={settings.general.showNotifications}
                    onChange={(value) => settings.setGeneral({ showNotifications: value })}
                  />
                </SettingRow>
              </SurfaceCard>
            </section>
          )}

          {active === "appearance" && (
            <section data-testid="settings-section-appearance" className="max-w-4xl">
              <SectionHeader label="Appearance" />
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {themes.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    data-testid={`theme-card-${theme.id}`}
                    data-active={settings.themeId === theme.id ? "true" : "false"}
                    onClick={() => applyTheme(theme.id)}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      settings.themeId === theme.id
                        ? "border-[var(--accent)] bg-[var(--surface-active)]"
                        : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--dim)]"
                    }`}
                  >
                    <div className="mb-3 flex gap-1">
                      {theme.colors.map((color) => (
                        <span
                          key={color}
                          className="h-4 flex-1 rounded-md"
                          style={{ background: color }}
                        />
                      ))}
                    </div>
                    <div className="text-[13px] text-[var(--fg)]">{theme.label}</div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {active === "keybinds" && (
            <section data-testid="settings-section-keybinds" className="max-w-4xl">
              <SectionHeader label="Keybinds" />
              {conflict && <div className="mb-2 text-[11px] text-[var(--yellow)]">{conflict}</div>}
              <SurfaceCard padded={false} className="divide-y divide-[var(--border-weak)]">
                {actions.map((action) => {
                  const effective = settings.keybinds[action.id] ?? action.keybind ?? "";
                  return (
                    <div
                      key={action.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12px] text-[var(--fg)]">{action.label}</div>
                        <div className="truncate text-[10px] text-[var(--dim)]">{action.id}</div>
                      </div>
                      <kbd
                        data-testid={`keybind-value-${action.id}`}
                        className="min-w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-center text-[11px] text-[var(--fg-secondary)]"
                      >
                        {editingAction === action.id ? "Press keys..." : effective || "unbound"}
                      </kbd>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`keybind-edit-${action.id}`}
                          onClick={() => setEditingAction(action.id)}
                          className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          edit
                        </button>
                        <button
                          type="button"
                          onClick={() => settings.resetKeybind(action.id)}
                          className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--dim)] hover:text-[var(--fg)]"
                        >
                          reset
                        </button>
                      </div>
                    </div>
                  );
                })}
              </SurfaceCard>
            </section>
          )}

          {active === "terminal" && (
            <section data-testid="settings-section-terminal" className="max-w-3xl">
              <SectionHeader label="Terminal" />
              <SurfaceCard className="mt-3">
                <SettingRow title="Font size" description="Applies to existing terminals.">
                  <input
                    type="range"
                    min={10}
                    max={20}
                    value={settings.terminal.fontSize}
                    onChange={(event) =>
                      settings.setTerminal({ fontSize: Number(event.currentTarget.value) })
                    }
                  />
                  <span className="w-10 text-right text-[12px] tabular-nums text-[var(--dim)]">
                    {settings.terminal.fontSize}px
                  </span>
                </SettingRow>
                <SettingRow title="Scrollback" description="Number of terminal lines retained.">
                  <input
                    type="number"
                    min={1000}
                    max={50000}
                    step={1000}
                    value={settings.terminal.scrollback}
                    onChange={(event) =>
                      settings.setTerminal({ scrollback: Number(event.currentTarget.value) })
                    }
                    className="w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px] tabular-nums"
                  />
                </SettingRow>
                <SettingRow title="Cursor blink">
                  <Toggle
                    checked={settings.terminal.cursorBlink}
                    onChange={(value) => settings.setTerminal({ cursorBlink: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="Renderer"
                  description="WebGL is fastest on desktop. Auto picks DOM on iOS / iPadOS where Safari WebGL has known glyph artifacts."
                >
                  <select
                    data-testid="settings-terminal-renderer"
                    value={settings.terminal.renderer}
                    onChange={(event) =>
                      settings.setTerminal({
                        renderer: event.currentTarget.value as "auto" | "webgl" | "dom",
                      })
                    }
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px]"
                  >
                    <option value="auto">Auto</option>
                    <option value="webgl">WebGL (force)</option>
                    <option value="dom">DOM (force)</option>
                  </select>
                </SettingRow>
              </SurfaceCard>
            </section>
          )}

          {active === "sounds" && (
            <section data-testid="settings-section-sounds" className="max-w-3xl">
              <SectionHeader label="Sounds" />
              <SurfaceCard className="mt-3">
                {[
                  ["onTaskComplete", "Task complete", "complete"],
                  ["onTaskError", "Task error", "error"],
                  ["onAgentIdle", "Agent idle", "idle"],
                ].map(([key, label, sound]) => (
                  <SettingRow key={key} title={label}>
                    <Toggle
                      checked={settings.sounds[key as keyof typeof settings.sounds]}
                      onChange={(value) =>
                        settings.setSound(key as keyof typeof settings.sounds, value)
                      }
                    />
                    <button
                      type="button"
                      onClick={() => playSound(sound as SoundKind, { force: true })}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      Test
                    </button>
                  </SettingRow>
                ))}
              </SurfaceCard>
            </section>
          )}

          {active === "about" && (
            <section data-testid="settings-section-about" className="max-w-3xl">
              <SectionHeader label="About" />
              <SurfaceCard className="mt-3 space-y-2 text-[12px] text-[var(--fg-secondary)]">
                <div>tmux-ide {process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}</div>
                <div>Build date: {process.env.NEXT_PUBLIC_BUILD_DATE ?? "local"}</div>
                <a
                  className="block text-[var(--cyan)] hover:underline"
                  href="https://github.com/wavyrai/tmux-ide"
                >
                  GitHub repository
                </a>
                <a
                  className="block text-[var(--cyan)] hover:underline"
                  href="https://github.com/wavyrai/tmux-ide/tree/main/docs"
                >
                  Documentation
                </a>
              </SurfaceCard>
            </section>
          )}
        </main>
      </div>
    </Panel>
  );
}
