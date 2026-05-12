"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  fetchProjectConfig,
  fetchSessions,
  restartProject,
  saveProjectConfig,
  type IdeConfigData,
} from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  RowSpaceBetween,
  Window,
} from "@/components/v2-primitives";
import type { SessionOverview } from "@/lib/types";

type TabId = "general" | "orchestrator" | "raw";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "raw", label: "Raw YAML" },
];

const DISPATCH_MODES = ["tasks", "goals", "missions"] as const;
type DispatchMode = (typeof DISPATCH_MODES)[number];

interface FormState {
  name: string;
  before: string;
  teamName: string;
  themeAccent: string;
  themeBorder: string;
  themeBg: string;
  themeFg: string;
  orchEnabled: boolean;
  orchAutoDispatch: boolean;
  orchDispatchMode: DispatchMode;
  orchPollInterval: number;
  orchMaxConcurrentAgents: number;
}

function emptyForm(): FormState {
  return {
    name: "",
    before: "",
    teamName: "",
    themeAccent: "",
    themeBorder: "",
    themeBg: "",
    themeFg: "",
    orchEnabled: false,
    orchAutoDispatch: false,
    orchDispatchMode: "missions",
    orchPollInterval: 5000,
    orchMaxConcurrentAgents: 10,
  };
}

function hydrateForm(config: IdeConfigData): FormState {
  return {
    name: config.name ?? "",
    before: config.before ?? "",
    teamName: config.team?.name ?? "",
    themeAccent: config.theme?.accent ?? "",
    themeBorder: config.theme?.border ?? "",
    themeBg: config.theme?.bg ?? "",
    themeFg: config.theme?.fg ?? "",
    orchEnabled: config.orchestrator?.enabled ?? false,
    orchAutoDispatch: config.orchestrator?.auto_dispatch ?? false,
    orchDispatchMode: (config.orchestrator?.dispatch_mode ?? "missions") as DispatchMode,
    orchPollInterval: config.orchestrator?.poll_interval ?? 5000,
    orchMaxConcurrentAgents: config.orchestrator?.max_concurrent_agents ?? 10,
  };
}

function applyForm(base: IdeConfigData, form: FormState): IdeConfigData {
  const next: IdeConfigData = { ...base };
  if (form.name.trim()) next.name = form.name.trim();
  if (form.before.trim()) {
    next.before = form.before.trim();
  } else {
    delete next.before;
  }

  const team = { ...(base.team ?? {}) };
  if (form.teamName.trim()) team.name = form.teamName.trim();
  else delete team.name;
  if (Object.keys(team).length > 0) next.team = team;
  else delete next.team;

  const theme = { ...(base.theme ?? {}) };
  setOrDelete(theme, "accent", form.themeAccent);
  setOrDelete(theme, "border", form.themeBorder);
  setOrDelete(theme, "bg", form.themeBg);
  setOrDelete(theme, "fg", form.themeFg);
  if (Object.keys(theme).length > 0) next.theme = theme;
  else delete next.theme;

  const orch = { ...(base.orchestrator ?? {}) };
  orch.enabled = form.orchEnabled;
  orch.auto_dispatch = form.orchAutoDispatch;
  orch.dispatch_mode = form.orchDispatchMode;
  orch.poll_interval = clamp(form.orchPollInterval, 100, 60_000);
  orch.max_concurrent_agents = clamp(form.orchMaxConcurrentAgents, 1, 50);
  next.orchestrator = orch;

  return next;
}

function setOrDelete(target: Record<string, string | undefined>, key: string, value: string) {
  if (value.trim()) target[key] = value.trim();
  else delete target[key];
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export default function ConfigV2Page() {
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [config, setConfig] = useState<IdeConfigData | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [tab, setTab] = useState<TabId>("general");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [restartState, setRestartState] = useState<"idle" | "running" | "success" | "error">(
    "idle",
  );
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchSessions();
      if (cancelled) return;
      setSessions(list);
      if (!sessionName && list.length > 0) {
        setSessionName(list[0]!.name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionName]);

  useEffect(() => {
    if (!sessionName) return;
    let cancelled = false;
    setLoadError(null);
    setSaveError(null);
    setSavedAt(null);
    void (async () => {
      const result = await fetchProjectConfig(sessionName);
      if (cancelled) return;
      if ("error" in result) {
        setLoadError(result.error);
        setConfig(null);
        setConfigPath(null);
        setForm(emptyForm());
        return;
      }
      setConfig(result.config);
      setConfigPath(result.configPath);
      setForm(hydrateForm(result.config));
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionName]);

  const dirty = useMemo(() => {
    if (!config) return false;
    const projected = applyForm(config, form);
    return JSON.stringify(projected) !== JSON.stringify(config);
  }, [config, form]);

  async function handleSave() {
    if (!sessionName || !config) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = applyForm(config, form);
      const result = await saveProjectConfig(sessionName, next);
      if ("error" in result) {
        setSaveError(result.error);
        return;
      }
      setConfig(result.config);
      setConfigPath(result.configPath);
      setForm(hydrateForm(result.config));
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart() {
    if (!sessionName) return;
    setRestartState("running");
    setRestartError(null);
    const result = await restartProject(sessionName);
    if ("error" in result) {
      setRestartState("error");
      setRestartError(result.error);
    } else {
      setRestartState("success");
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex h-7 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 text-[11px] tabular-nums">
        <Link
          href="/v2"
          className="mr-2 inline-flex items-center gap-1 text-[var(--dim)] hover:text-[var(--fg)]"
        >
          <span aria-hidden="true">◇</span>
          <span>tmux-ide</span>
        </Link>
        <span className="mx-1 text-[var(--dimmer)]">/</span>
        <span className="font-medium text-[var(--accent)]">config</span>
        <span className="flex-1" />
        <select
          value={sessionName ?? ""}
          onChange={(event) => setSessionName(event.target.value || null)}
          className="h-5 rounded border border-[var(--border)] bg-[var(--bg-strong)] px-1 text-[11px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        >
          {sessions.length === 0 && <option value="">No sessions</option>}
          {sessions.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!sessionName && (
          <Card title="NO SESSIONS" mode="left">
            <p className="text-[var(--dim)]">
              No tmux-ide sessions discovered. Run <code>tmux-ide init</code> in a project to create
              one.
            </p>
          </Card>
        )}

        {sessionName && loadError && (
          <Card title="FAILED TO LOAD CONFIG" mode="left">
            <p className="text-[var(--red)]">{loadError}</p>
            <p className="text-[var(--dim)]">Session: {sessionName}</p>
          </Card>
        )}

        {sessionName && !loadError && config && (
          <>
            <Card title="IDE.YML" mode="left">
              <RowSpaceBetween>
                <div className="flex gap-1">
                  {TABS.map((t) => (
                    <Button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      theme={tab === t.id ? "PRIMARY" : "SECONDARY"}
                    >
                      {t.label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-1">
                  <Button onClick={handleSave} theme="PRIMARY" isDisabled={saving || !dirty}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    onClick={handleRestart}
                    theme="SECONDARY"
                    isDisabled={restartState === "running"}
                  >
                    {restartState === "running" ? "Restarting…" : "Restart"}
                  </Button>
                </div>
              </RowSpaceBetween>
              <RowSpaceBetween>
                <span className="text-[var(--dim)]">
                  {configPath ?? "—"}
                  {dirty ? " · unsaved changes" : ""}
                  {savedAt ? ` · saved ${savedAt}` : ""}
                </span>
                <Badge>{tab}</Badge>
              </RowSpaceBetween>
              {saveError && <p className="mt-2 text-[var(--red)]">save: {saveError}</p>}
              {restartState === "success" && (
                <p className="mt-2 text-[var(--green)]">restart succeeded</p>
              )}
              {restartState === "error" && restartError && (
                <p className="mt-2 text-[var(--red)]">restart: {restartError}</p>
              )}
            </Card>

            <br />

            {tab === "general" && (
              <GeneralTab form={form} update={update} rowsCount={countRows(config)} />
            )}
            {tab === "orchestrator" && <OrchestratorTab form={form} update={update} />}
            {tab === "raw" && <RawTab config={config} />}
          </>
        )}
      </div>
    </div>
  );
}

function countRows(config: IdeConfigData): number {
  return Array.isArray(config.rows) ? config.rows.length : 0;
}

interface FieldUpdater {
  <K extends keyof FormState>(key: K, value: FormState[K]): void;
}

function GeneralTab({
  form,
  update,
  rowsCount,
}: {
  form: FormState;
  update: FieldUpdater;
  rowsCount: number;
}) {
  return (
    <>
      <Card title="GENERAL" mode="left">
        <FieldText
          label="Session name"
          value={form.name}
          onChange={(v) => update("name", v)}
          hint="tmux session name. Required."
        />
        <FieldText
          label="Before hook"
          value={form.before}
          onChange={(v) => update("before", v)}
          hint="Optional shell command run before launching panes (e.g. pnpm install)."
        />
        <FieldText
          label="Team name"
          value={form.teamName}
          onChange={(v) => update("teamName", v)}
          hint="Optional. Enables agent-team mode when set."
        />
      </Card>

      <br />

      <Card title="THEME" mode="left">
        <FieldText
          label="Accent"
          value={form.themeAccent}
          onChange={(v) => update("themeAccent", v)}
          hint="tmux color (e.g. colour75)"
        />
        <FieldText
          label="Border"
          value={form.themeBorder}
          onChange={(v) => update("themeBorder", v)}
          hint="tmux color"
        />
        <FieldText
          label="Background"
          value={form.themeBg}
          onChange={(v) => update("themeBg", v)}
          hint="tmux color"
        />
        <FieldText
          label="Foreground"
          value={form.themeFg}
          onChange={(v) => update("themeFg", v)}
          hint="tmux color"
        />
      </Card>

      <br />

      <Card title="LAYOUT" mode="left">
        <RowSpaceBetween>
          <span>Rows configured</span>
          <Badge>{rowsCount}</Badge>
        </RowSpaceBetween>
        <p className="text-[var(--dim)]">
          Pane layout editing isn&apos;t exposed in this MVP form — edit <code>rows:</code> directly
          in the Raw YAML tab, then Save.
        </p>
      </Card>
    </>
  );
}

function OrchestratorTab({ form, update }: { form: FormState; update: FieldUpdater }) {
  return (
    <Card title="ORCHESTRATOR" mode="left">
      <FieldCheckbox
        label="Enabled"
        value={form.orchEnabled}
        onChange={(v) => update("orchEnabled", v)}
        hint="Master switch for the orchestrator. When off, no auto-dispatch happens."
      />
      <FieldCheckbox
        label="Auto-dispatch"
        value={form.orchAutoDispatch}
        onChange={(v) => update("orchAutoDispatch", v)}
        hint="Automatically assign idle agents to the next unblocked task."
      />
      <FieldSelect
        label="Dispatch mode"
        value={form.orchDispatchMode}
        options={DISPATCH_MODES}
        onChange={(v) => update("orchDispatchMode", v as DispatchMode)}
        hint="missions = milestone-gated; goals = goal-priority; tasks = flat priority order."
      />
      <FieldNumber
        label="Poll interval (ms)"
        value={form.orchPollInterval}
        min={100}
        max={60_000}
        onChange={(v) => update("orchPollInterval", v)}
        hint="How often the orchestrator ticks. 100–60000 ms."
      />
      <FieldNumber
        label="Max concurrent agents"
        value={form.orchMaxConcurrentAgents}
        min={1}
        max={50}
        onChange={(v) => update("orchMaxConcurrentAgents", v)}
        hint="Cap on simultaneously dispatched agents. 1–50."
      />
    </Card>
  );
}

function RawTab({ config }: { config: IdeConfigData }) {
  return (
    <Window>
      <CodeBlock data-lang="json">{JSON.stringify(config, null, 2)}</CodeBlock>
    </Window>
  );
}

const fieldClass =
  "w-full rounded border border-[var(--border)] bg-[var(--bg-strong)] px-2 py-1 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]";

function FieldText({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="mb-2 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
      {hint && <span className="text-[10px] text-[var(--dimmer)]">{hint}</span>}
    </label>
  );
}

function FieldNumber({
  label,
  value,
  onChange,
  hint,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className="mb-2 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className={fieldClass}
      />
      {hint && <span className="text-[10px] text-[var(--dimmer)]">{hint}</span>}
    </label>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="mb-2 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {hint && <span className="text-[10px] text-[var(--dimmer)]">{hint}</span>}
    </label>
  );
}

function FieldCheckbox({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <RowSpaceBetween>
      <span>
        <span className="text-[12px] text-[var(--fg)]">{label}</span>
        {hint && <span className="ml-2 text-[10px] text-[var(--dimmer)]">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
      />
    </RowSpaceBetween>
  );
}
