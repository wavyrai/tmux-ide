/**
 * SkillsView — Solid port of dashboard/components/skills/SkillsView.tsx
 * (retired in the U5 orphan sweep). Restores the / "Skills" surface.
 *
 * Two-pane composite: a left rail listing project skills + a right
 * detail panel rendering the selected skill's markdown body. Skills
 * are owned by the host (the React bridge calls
 * `/api/project/:name/skills` and pushes the list via `setOptions`).
 * The widget owns the selected-skill id + search filter.
 *
 * Body markdown is rendered through `marked` and dropped into a
 * `.chat-markdown` wrapper so it picks up the global typography block
 * (PR 4 of the design rollout). Skill content is project-local data,
 * not adversarial — XSS is out of scope. If a future surface ever
 * sources skill body from external input, sanitize at the boundary.
 *
 * Semantic data-* hooks for tests + CSS overrides:
 *   - data-testid="skills-view"
 *   - data-testid="skills-rail" / "skills-detail"
 *   - data-testid="skill-row-<name>" + data-skill-name + data-selected
 *   - data-testid="skill-detail-name" / "skill-detail-body"
 *   - data-testid="skills-search"
 *   - data-empty-state on the empty rail + empty detail
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { marked } from "marked";
import type { SkillFormValues, SkillsViewMountOptions, SkillSummary } from "../types";

interface SkillsViewProps {
  options: () => SkillsViewMountOptions;
}

type EditorMode = { kind: "create" } | { kind: "edit"; original: SkillSummary };

interface FormState {
  name: string;
  role: string;
  description: string;
  specialties: string;
  body: string;
}

function emptyForm(): FormState {
  return { name: "", role: "teammate", description: "", specialties: "", body: "" };
}

function fromSkill(skill: SkillSummary): FormState {
  return {
    name: skill.name,
    role: skill.role ?? "teammate",
    description: skill.description ?? "",
    specialties: (skill.specialties ?? []).join(", "),
    body: skill.body ?? "",
  };
}

function toValues(form: FormState): SkillFormValues {
  return {
    name: form.name.trim(),
    role: form.role.trim() || "teammate",
    description: form.description,
    specialties: form.specialties
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    body: form.body,
  };
}

function roleLabel(role: string | undefined): string {
  if (!role) return "teammate";
  return role.toLowerCase();
}

function renderMarkdown(body: string): string {
  if (!body.trim()) return "";
  try {
    const out = marked.parse(body, { async: false });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

export function SkillsViewView(props: SkillsViewProps) {
  const initialSelected = props.options().initialSelected ?? null;
  const [selected, setSelected] = createSignal<string | null>(initialSelected);
  const [query, setQuery] = createSignal("");
  const [editor, setEditor] = createSignal<EditorMode | null>(null);
  const [form, setForm] = createSignal<FormState>(emptyForm());
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  const canCreate = createMemo(() => typeof props.options().onCreate === "function");
  const canUpdate = createMemo(() => typeof props.options().onUpdate === "function");
  const canDelete = createMemo(() => typeof props.options().onDelete === "function");

  function openCreate() {
    if (!canCreate()) return;
    setForm(emptyForm());
    setErrorMsg(null);
    setEditor({ kind: "create" });
  }

  function openEdit(skill: SkillSummary) {
    if (!canUpdate()) return;
    setForm(fromSkill(skill));
    setErrorMsg(null);
    setEditor({ kind: "edit", original: skill });
  }

  function closeEditor() {
    setEditor(null);
    setSubmitting(false);
    setErrorMsg(null);
  }

  async function submit() {
    const mode = editor();
    if (!mode) return;
    const values = toValues(form());
    if (!values.name) {
      setErrorMsg("Name is required.");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (mode.kind === "create") {
        await props.options().onCreate?.(values);
      } else {
        await props.options().onUpdate?.(mode.original.name, values);
      }
      closeEditor();
      setSelected(values.name);
    } catch (err) {
      setErrorMsg((err as Error).message ?? "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    const name = pendingDelete();
    if (!name) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await props.options().onDelete?.(name);
      setPendingDelete(null);
      if (selected() === name) setSelected(null);
    } catch (err) {
      setErrorMsg((err as Error).message ?? "Delete failed");
    } finally {
      setSubmitting(false);
    }
  }

  const allSkills = createMemo<ReadonlyArray<SkillSummary>>(() => props.options().skills ?? []);

  // Filter by search. The match scans name, description, role, specialties.
  const filtered = createMemo<SkillSummary[]>(() => {
    const q = query().trim().toLowerCase();
    const list = allSkills();
    if (!q) return [...list];
    return list.filter((s) => {
      const hay =
        `${s.name} ${s.description ?? ""} ${s.role ?? ""} ${(s.specialties ?? []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  });

  // Skill rail virtualizer: a project with thousands of skills no
  // longer renders thousands of buttons. Inline calls to
  // `getVirtualItems` / `getTotalSize` inside JSX do not subscribe
  // to the virtualizer's signal — wrap in `createMemo` per 9b139e5.
  const [railEl, setRailEl] = createSignal<HTMLDivElement | null>(null);
  const skillsVirtualizer = createVirtualizer({
    get count() {
      return filtered().length;
    },
    getScrollElement: () => railEl(),
    estimateSize: () => 28,
    overscan: 6,
    getItemKey: (i) => filtered()[i]?.name ?? i,
  });
  const skillsVirtualItems = createMemo(() => skillsVirtualizer.getVirtualItems());
  const skillsVirtualTotalSize = createMemo(() => skillsVirtualizer.getTotalSize());

  // Resolve the selected skill summary against the live list.
  const activeSkill = createMemo<SkillSummary | null>(() => {
    const id = selected();
    if (!id) return null;
    const match = allSkills().find((s) => s.name === id);
    if (match) return match;
    return null;
  });

  // Auto-select the first filtered row when the current selection vanishes
  // (e.g. search query that excludes it) — keeps the detail panel useful.
  const visibleSelection = createMemo<SkillSummary | null>(() => {
    const cur = activeSkill();
    if (cur && filtered().some((s) => s.name === cur.name)) return cur;
    const first = filtered()[0];
    return first ?? null;
  });

  function handleRowClick(name: string) {
    setSelected(name);
    props.options().onSelect?.(name);
  }

  const bodyHtml = createMemo<string>(() => {
    const skill = visibleSelection();
    if (!skill || !skill.body) return "";
    return renderMarkdown(skill.body);
  });

  return (
    <div
      data-testid="skills-view"
      style={{
        position: "relative",
        display: "flex",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg)",
        color: "var(--fg)",
        "font-family": "var(--font-mono)",
        "font-size": "var(--text-base)",
      }}
    >
      {/* ----- Left rail ------------------------------------------------ */}
      <aside
        data-testid="skills-rail"
        style={{
          flex: "0 0 280px",
          "min-width": "0",
          display: "flex",
          "flex-direction": "column",
          "border-right": "1px solid var(--border)",
          "background-color": "var(--bg-weak, var(--bg))",
        }}
      >
        <header
          style={{
            display: "flex",
            "align-items": "center",
            gap: "var(--space-2)",
            padding: "var(--space-2)",
            "border-bottom": "1px solid var(--border-weak, var(--border))",
          }}
        >
          <span
            style={{
              color: "var(--fg-muted, var(--fg-soft))",
              "font-size": "var(--text-xs)",
              "text-transform": "uppercase",
              "letter-spacing": "0.08em",
            }}
          >
            Skills
          </span>
          <span
            data-testid="skills-count"
            style={{
              "margin-left": "auto",
              color: "var(--dim)",
              "font-size": "var(--text-xs)",
              "font-variant-numeric": "tabular-nums",
            }}
          >
            {filtered().length}/{allSkills().length}
          </span>
          <Show when={canCreate()}>
            <button
              type="button"
              data-testid="skills-new-button"
              onClick={() => openCreate()}
              style={{
                "margin-left": "6px",
                padding: "var(--space-1) var(--space-2)",
                "border-radius": "4px",
                border: "1px solid var(--border)",
                "background-color": "transparent",
                color: "var(--accent)",
                "font-family": "inherit",
                "font-size": "var(--text-xs)",
                cursor: "pointer",
              }}
            >
              + New
            </button>
          </Show>
        </header>
        <div style={{ padding: "var(--space-2)" }}>
          <input
            data-testid="skills-search"
            type="search"
            placeholder="Search skills…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            style={{
              width: "100%",
              padding: "var(--space-1) var(--space-2)",
              "border-radius": "4px",
              border: "1px solid var(--border)",
              "background-color": "var(--bg)",
              color: "var(--fg)",
              "font-family": "inherit",
              "font-size": "var(--text-sm)",
            }}
          />
        </div>
        <div
          ref={setRailEl}
          style={{
            flex: "1 1 0%",
            "min-height": "0",
            "overflow-y": "auto",
            padding: "0 4px 6px",
            position: "relative",
          }}
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <div
                data-empty-state
                style={{
                  color: "var(--dim)",
                  "font-size": "var(--text-sm)",
                  padding: "var(--space-4) var(--space-2)",
                  "text-align": "center",
                }}
              >
                <Show when={allSkills().length === 0} fallback="No matches.">
                  — no skills registered —
                </Show>
              </div>
            }
          >
            <div
              data-testid="skills-rail-spacer"
              style={{
                height: `${skillsVirtualTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              <For each={skillsVirtualItems()}>
                {(vItem) => {
                  const skill = () => filtered()[vItem.index]!;
                  const isActive = () => visibleSelection()?.name === skill().name;
                  return (
                    <div
                      data-index={vItem.index}
                      ref={(el) => skillsVirtualizer.measureElement(el)}
                      style={{
                        position: "absolute",
                        top: "0",
                        left: "0",
                        width: "100%",
                        transform: `translateY(${vItem.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        data-testid={`skill-row-${skill().name}`}
                        data-skill-name={skill().name}
                        data-selected={isActive() ? "true" : "false"}
                        onClick={() => handleRowClick(skill().name)}
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "var(--space-2)",
                          width: "100%",
                          padding: "var(--space-2)",
                          "border-radius": "4px",
                          border: "none",
                          "background-color": isActive()
                            ? "color-mix(in oklab, var(--accent) 14%, transparent)"
                            : "transparent",
                          color: isActive() ? "var(--accent)" : "var(--fg)",
                          "font-family": "inherit",
                          "font-size": "var(--text-base)",
                          "text-align": "left",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: "inline-block",
                            width: "7px",
                            height: "7px",
                            "border-radius": "50%",
                            "background-color": isActive() ? "var(--accent)" : "var(--dim)",
                          }}
                        />
                        <span
                          style={{
                            flex: "1 1 0%",
                            "min-width": "0",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                          title={skill().description ?? skill().name}
                        >
                          {skill().name}
                        </span>
                        <Show when={skill().specialties && skill().specialties!.length > 0}>
                          <span
                            style={{
                              color: "var(--fg-muted, var(--fg-soft))",
                              "font-size": "var(--text-xs)",
                            }}
                          >
                            {skill().specialties![0]}
                          </span>
                        </Show>
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </aside>

      {/* ----- Right detail --------------------------------------------- */}
      <section
        data-testid="skills-detail"
        style={{
          flex: "1 1 0%",
          "min-width": "0",
          display: "flex",
          "flex-direction": "column",
          "min-height": "0",
        }}
      >
        <Show
          when={visibleSelection()}
          fallback={
            <div
              data-empty-state
              style={{
                flex: "1 1 0%",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                color: "var(--dim)",
                "font-size": "var(--text-base)",
                padding: "40px var(--space-3)",
              }}
            >
              <Show when={allSkills().length === 0} fallback="Select a skill from the rail.">
                — no skills registered for this project —
              </Show>
            </div>
          }
        >
          {(skillAccessor) => (
            <>
              <header
                style={{
                  display: "flex",
                  "flex-wrap": "wrap",
                  "align-items": "baseline",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-4)",
                  "border-bottom": "1px solid var(--border)",
                  "background-color": "var(--bg-weak, var(--bg))",
                }}
              >
                <h2
                  data-testid="skill-detail-name"
                  style={{
                    margin: "0",
                    "font-size": "var(--text-lg)",
                    "font-weight": "600",
                    color: "var(--fg)",
                  }}
                >
                  {skillAccessor().name}
                </h2>
                <span
                  data-testid="skill-detail-role"
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    "border-radius": "10px",
                    "background-color": "color-mix(in oklab, var(--accent) 14%, transparent)",
                    color: "var(--accent)",
                    "font-size": "var(--text-xs)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.04em",
                  }}
                >
                  {roleLabel(skillAccessor().role)}
                </span>
                <Show when={skillAccessor().specialties && skillAccessor().specialties!.length > 0}>
                  <div
                    data-testid="skill-detail-specialties"
                    style={{ display: "flex", gap: "var(--space-1)", "flex-wrap": "wrap" }}
                  >
                    <For each={skillAccessor().specialties!}>
                      {(s) => (
                        <span
                          style={{
                            padding: "var(--space-1) var(--space-2)",
                            "border-radius": "10px",
                            border: "1px solid var(--border-weak, var(--border))",
                            color: "var(--fg-muted, var(--fg-soft))",
                            "font-size": "var(--text-xs)",
                          }}
                        >
                          {s}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={canUpdate() || canDelete()}>
                  <div
                    style={{
                      "margin-left": "auto",
                      display: "flex",
                      gap: "var(--space-2)",
                    }}
                  >
                    <Show when={canUpdate()}>
                      <button
                        type="button"
                        data-testid="skill-edit-button"
                        onClick={() => openEdit(skillAccessor())}
                        style={{
                          padding: "var(--space-1) var(--space-2)",
                          "border-radius": "4px",
                          border: "1px solid var(--border)",
                          "background-color": "transparent",
                          color: "var(--fg)",
                          "font-family": "inherit",
                          "font-size": "var(--text-sm)",
                          cursor: "pointer",
                        }}
                      >
                        Edit
                      </button>
                    </Show>
                    <Show when={canDelete()}>
                      <button
                        type="button"
                        data-testid="skill-delete-button"
                        onClick={() => {
                          setErrorMsg(null);
                          setPendingDelete(skillAccessor().name);
                        }}
                        style={{
                          padding: "var(--space-1) var(--space-2)",
                          "border-radius": "4px",
                          border: "1px solid var(--border)",
                          "background-color": "transparent",
                          color: "var(--danger, #d34)",
                          "font-family": "inherit",
                          "font-size": "var(--text-sm)",
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </Show>
                  </div>
                </Show>
              </header>
              <Show when={skillAccessor().description}>
                <p
                  data-testid="skill-detail-description"
                  style={{
                    margin: "0",
                    padding: "var(--space-2) var(--space-4)",
                    "border-bottom": "1px solid var(--border-weak, var(--border))",
                    color: "var(--fg-muted, var(--fg-soft))",
                    "font-size": "var(--text-base)",
                    "line-height": "1.5",
                  }}
                >
                  {skillAccessor().description}
                </p>
              </Show>
              <div
                style={{
                  flex: "1 1 0%",
                  "min-height": "0",
                  "overflow-y": "auto",
                  padding: "12px 14px 24px",
                }}
              >
                <Show
                  when={skillAccessor().body && skillAccessor().body!.trim()}
                  fallback={
                    <div
                      data-empty-state
                      style={{
                        color: "var(--dim)",
                        "font-size": "var(--text-sm)",
                        "font-style": "italic",
                      }}
                    >
                      — empty body —
                    </div>
                  }
                >
                  <div
                    class="chat-markdown"
                    data-testid="skill-detail-body"
                    // eslint-disable-next-line solid/no-innerhtml
                    innerHTML={bodyHtml()}
                  />
                </Show>
              </div>
            </>
          )}
        </Show>
      </section>

      {/* ----- Editor overlay (create / edit) --------------------------- */}
      <Show when={editor()}>
        {(mode) => (
          <div
            data-testid="skill-editor"
            data-editor-mode={mode().kind}
            style={{
              position: "absolute",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "background-color": "rgba(0,0,0,0.4)",
              "z-index": "20",
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) closeEditor();
            }}
          >
            <div
              style={{
                width: "min(540px, 90%)",
                "max-height": "85%",
                display: "flex",
                "flex-direction": "column",
                "background-color": "var(--bg)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                "border-radius": "6px",
                "box-shadow": "0 12px 32px rgba(0,0,0,0.4)",
              }}
            >
              <header
                style={{
                  padding: "var(--space-2) var(--space-4)",
                  "border-bottom": "1px solid var(--border-weak, var(--border))",
                  "font-size": "var(--text-md)",
                  "font-weight": "600",
                }}
              >
                {mode().kind === "create"
                  ? "New skill"
                  : `Edit ${mode().kind === "edit" ? (mode() as { original: SkillSummary }).original.name : ""}`}
              </header>
              <div
                style={{
                  padding: "12px 14px",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "var(--space-2)",
                  "overflow-y": "auto",
                  flex: "1 1 0%",
                  "min-height": "0",
                }}
              >
                <label
                  style={{ display: "flex", "flex-direction": "column", gap: "var(--space-1)" }}
                >
                  <span
                    style={{
                      "font-size": "var(--text-xs)",
                      color: "var(--dim)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.06em",
                    }}
                  >
                    Name
                  </span>
                  <input
                    data-testid="skill-form-name"
                    type="text"
                    value={form().name}
                    disabled={mode().kind === "edit"}
                    onInput={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))}
                    style={{
                      padding: "var(--space-2)",
                      border: "1px solid var(--border)",
                      "border-radius": "4px",
                      "background-color": "var(--bg-weak, var(--bg))",
                      color: "var(--fg)",
                      "font-family": "inherit",
                      "font-size": "var(--text-base)",
                    }}
                  />
                </label>
                <label
                  style={{ display: "flex", "flex-direction": "column", gap: "var(--space-1)" }}
                >
                  <span
                    style={{
                      "font-size": "var(--text-xs)",
                      color: "var(--dim)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.06em",
                    }}
                  >
                    Role
                  </span>
                  <input
                    data-testid="skill-form-role"
                    type="text"
                    value={form().role}
                    onInput={(e) => setForm((f) => ({ ...f, role: e.currentTarget.value }))}
                    style={{
                      padding: "var(--space-2)",
                      border: "1px solid var(--border)",
                      "border-radius": "4px",
                      "background-color": "var(--bg-weak, var(--bg))",
                      color: "var(--fg)",
                      "font-family": "inherit",
                      "font-size": "var(--text-base)",
                    }}
                  />
                </label>
                <label
                  style={{ display: "flex", "flex-direction": "column", gap: "var(--space-1)" }}
                >
                  <span
                    style={{
                      "font-size": "var(--text-xs)",
                      color: "var(--dim)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.06em",
                    }}
                  >
                    Specialties (comma-separated)
                  </span>
                  <input
                    data-testid="skill-form-specialties"
                    type="text"
                    value={form().specialties}
                    onInput={(e) => setForm((f) => ({ ...f, specialties: e.currentTarget.value }))}
                    style={{
                      padding: "var(--space-2)",
                      border: "1px solid var(--border)",
                      "border-radius": "4px",
                      "background-color": "var(--bg-weak, var(--bg))",
                      color: "var(--fg)",
                      "font-family": "inherit",
                      "font-size": "var(--text-base)",
                    }}
                  />
                </label>
                <label
                  style={{ display: "flex", "flex-direction": "column", gap: "var(--space-1)" }}
                >
                  <span
                    style={{
                      "font-size": "var(--text-xs)",
                      color: "var(--dim)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.06em",
                    }}
                  >
                    Description
                  </span>
                  <input
                    data-testid="skill-form-description"
                    type="text"
                    value={form().description}
                    onInput={(e) => setForm((f) => ({ ...f, description: e.currentTarget.value }))}
                    style={{
                      padding: "var(--space-2)",
                      border: "1px solid var(--border)",
                      "border-radius": "4px",
                      "background-color": "var(--bg-weak, var(--bg))",
                      color: "var(--fg)",
                      "font-family": "inherit",
                      "font-size": "var(--text-base)",
                    }}
                  />
                </label>
                <label
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    gap: "var(--space-1)",
                    flex: "1 1 0%",
                    "min-height": "0",
                  }}
                >
                  <span
                    style={{
                      "font-size": "var(--text-xs)",
                      color: "var(--dim)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.06em",
                    }}
                  >
                    Body (markdown)
                  </span>
                  <textarea
                    data-testid="skill-form-body"
                    value={form().body}
                    onInput={(e) => setForm((f) => ({ ...f, body: e.currentTarget.value }))}
                    style={{
                      padding: "var(--space-2)",
                      border: "1px solid var(--border)",
                      "border-radius": "4px",
                      "background-color": "var(--bg-weak, var(--bg))",
                      color: "var(--fg)",
                      "font-family": "var(--font-mono)",
                      "font-size": "var(--text-base)",
                      "min-height": "180px",
                      resize: "vertical",
                    }}
                  />
                </label>
                <Show when={errorMsg()}>
                  <div
                    data-testid="skill-form-error"
                    style={{ color: "var(--danger, #d34)", "font-size": "var(--text-sm)" }}
                  >
                    {errorMsg()}
                  </div>
                </Show>
              </div>
              <footer
                style={{
                  display: "flex",
                  "justify-content": "flex-end",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-4)",
                  "border-top": "1px solid var(--border-weak, var(--border))",
                }}
              >
                <button
                  type="button"
                  data-testid="skill-form-cancel"
                  onClick={() => closeEditor()}
                  disabled={submitting()}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    "border-radius": "4px",
                    border: "1px solid var(--border)",
                    "background-color": "transparent",
                    color: "var(--fg)",
                    "font-family": "inherit",
                    "font-size": "var(--text-sm)",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="skill-form-save"
                  onClick={() => void submit()}
                  disabled={submitting()}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    "border-radius": "4px",
                    border: "1px solid var(--accent)",
                    "background-color": "var(--accent)",
                    color: "var(--bg)",
                    "font-family": "inherit",
                    "font-size": "var(--text-sm)",
                    cursor: "pointer",
                  }}
                >
                  {submitting() ? "Saving…" : "Save"}
                </button>
              </footer>
            </div>
          </div>
        )}
      </Show>

      {/* ----- Delete confirm ------------------------------------------- */}
      <Show when={pendingDelete()}>
        {(name) => (
          <div
            data-testid="skill-delete-confirm"
            data-skill-name={name()}
            style={{
              position: "absolute",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "background-color": "rgba(0,0,0,0.4)",
              "z-index": "20",
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setPendingDelete(null);
            }}
          >
            <div
              style={{
                width: "min(420px, 90%)",
                "background-color": "var(--bg)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                "border-radius": "6px",
                padding: "var(--space-4)",
                "box-shadow": "0 12px 32px rgba(0,0,0,0.4)",
              }}
            >
              <p
                style={{
                  margin: "0 0 12px 0",
                  "font-size": "var(--text-base)",
                  "line-height": "1.5",
                }}
              >
                Delete skill <strong>{name()}</strong>? This removes{" "}
                <code>.tmux-ide/skills/{name()}.md</code> from disk.
              </p>
              <Show when={errorMsg()}>
                <div
                  data-testid="skill-delete-error"
                  style={{
                    color: "var(--danger, #d34)",
                    "font-size": "var(--text-sm)",
                    "margin-bottom": "8px",
                  }}
                >
                  {errorMsg()}
                </div>
              </Show>
              <div
                style={{ display: "flex", "justify-content": "flex-end", gap: "var(--space-2)" }}
              >
                <button
                  type="button"
                  data-testid="skill-delete-cancel"
                  onClick={() => setPendingDelete(null)}
                  disabled={submitting()}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    "border-radius": "4px",
                    border: "1px solid var(--border)",
                    "background-color": "transparent",
                    color: "var(--fg)",
                    "font-family": "inherit",
                    "font-size": "var(--text-sm)",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="skill-delete-confirm-button"
                  onClick={() => void confirmDelete()}
                  disabled={submitting()}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    "border-radius": "4px",
                    border: "1px solid var(--danger, #d34)",
                    "background-color": "var(--danger, #d34)",
                    color: "var(--bg)",
                    "font-family": "inherit",
                    "font-size": "var(--text-sm)",
                    cursor: "pointer",
                  }}
                >
                  {submitting() ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
