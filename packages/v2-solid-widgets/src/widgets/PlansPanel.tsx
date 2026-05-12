/**
 * PlansPanel — Solid port of dashboard/components/PlansPanel.tsx's
 * detail half. Renders the markdown body of a single plan, split by
 * heading into authorship-bordered sections (AI/human border + author
 * badge + relative-time chip).
 *
 * Companion to [[PlansRail]] (rail = list, panel = detail). Prop-driven:
 * the React host fetches /api/project/:name/plans/:file via lib/api.ts
 * and pushes the resulting PlanData through `setOptions({ planData })`.
 * The widget never fetches — that contract lives in the host.
 *
 * Markdown is rendered via `marked` (sync mode) and injected as HTML.
 * Plan content is project-local user-owned data, not adversarial; XSS
 * is out of scope. If the host ever sources plan content from external
 * input, sanitize at the boundary.
 */
import { createMemo, For, Show } from "solid-js";
import { marked } from "marked";
import type { PlansPanelMountOptions, PlansPanelAuthorshipSection } from "../types";

interface PlansPanelViewProps {
  options: () => PlansPanelMountOptions;
}

interface RenderedSection {
  heading: string;
  html: string;
  author: string | null;
  authorAt: string | null;
}

const STATUS_DOT: Record<string, string> = {
  "in-progress": "var(--yellow)",
  pending: "var(--dim)",
  done: "var(--green)",
  archived: "var(--dimmer)",
};

const STATUS_PILL_BG: Record<string, string> = {
  "in-progress": "color-mix(in oklab, var(--yellow) 15%, transparent)",
  pending: "color-mix(in oklab, var(--dim) 15%, transparent)",
  done: "color-mix(in oklab, var(--green) 15%, transparent)",
  archived: "color-mix(in oklab, var(--dimmer) 15%, transparent)",
};

const STATUS_PILL_FG: Record<string, string> = {
  "in-progress": "var(--yellow)",
  pending: "var(--fg-secondary)",
  done: "var(--green)",
  archived: "var(--dimmer)",
};

function isAiAuthor(author: string | null): boolean {
  return Boolean(author && author.startsWith("ai"));
}

function formatAuthorTime(at: string | null): string {
  if (!at) return "";
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function splitSections(
  content: string,
  authorshipSections: Record<string, PlansPanelAuthorshipSection> | null,
): RenderedSection[] {
  const lines = content.split("\n");
  const out: RenderedSection[] = [];
  let currentHeading = "";
  let buf: string[] = [];

  const flush = () => {
    if (!buf.length && !currentHeading) return;
    const md = buf.join("\n");
    // marked.parse with `async: false` returns string synchronously
    const html = marked.parse(md, { async: false }) as string;
    const sectionAuth = authorshipSections?.[currentHeading] ?? null;
    out.push({
      heading: currentHeading,
      html,
      author: sectionAuth?.author ?? null,
      authorAt: sectionAuth?.at ?? null,
    });
  };

  for (const line of lines) {
    const m = line.match(/^#{1,4}\s+(.+)/);
    if (m) {
      flush();
      currentHeading = m[1]!.trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

export function PlansPanelView(props: PlansPanelViewProps) {
  const sections = createMemo<RenderedSection[]>(() => {
    const opts = props.options();
    const planData = opts.planData;
    if (!planData) return [];
    return splitSections(planData.content, planData.authorship?.sections ?? null);
  });

  const plan = createMemo(() => props.options().plan ?? null);
  const isEmpty = createMemo(() => {
    const opts = props.options();
    return !opts.planData || !opts.planData.content;
  });

  return (
    <div
      data-testid="plans-panel-solid"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg)",
        color: "var(--fg)",
        "font-family": "var(--font-family-mono, var(--font-mono))",
        "font-size": "12px",
      }}
    >
      <Show when={plan()}>
        {(p) => (
          <header
            data-testid="plans-panel-header"
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              height: "28px",
              "flex-shrink": "0",
              "border-bottom": "1px solid var(--border)",
              padding: "0 12px",
              "background-color": "var(--bg-strong)",
              "font-size": "11px",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                height: "6px",
                width: "6px",
                "border-radius": "9999px",
                background: STATUS_DOT[p().status] ?? "var(--dim)",
              }}
            />
            <span style={{ color: "var(--fg)", "font-weight": "500" }}>
              {p().title || p().name}
            </span>
            <span
              data-testid="plans-panel-status-pill"
              style={{
                "border-radius": "9999px",
                padding: "1px 6px",
                "font-size": "10px",
                background: STATUS_PILL_BG[p().status] ?? "var(--surface)",
                color: STATUS_PILL_FG[p().status] ?? "var(--fg-secondary)",
              }}
            >
              {p().status}
            </span>
            <span style={{ flex: "1" }} />
            <Show when={p().status !== "done" && props.options().onMarkDone}>
              <button
                type="button"
                data-testid="plans-panel-mark-done"
                onClick={() => props.options().onMarkDone?.()}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--green)",
                  cursor: "pointer",
                  "font-size": "11px",
                  "font-family": "inherit",
                  padding: "0",
                }}
              >
                [mark done]
              </button>
            </Show>
            <Show when={props.options().onEdit}>
              <button
                type="button"
                data-testid="plans-panel-edit"
                onClick={() => props.options().onEdit?.()}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--dim)",
                  cursor: "pointer",
                  "font-size": "11px",
                  "font-family": "inherit",
                  padding: "0",
                }}
              >
                [edit]
              </button>
            </Show>
          </header>
        )}
      </Show>

      <div
        data-testid="plans-panel-body"
        style={{
          flex: "1",
          "min-height": "0",
          "overflow-y": "auto",
          padding: "12px 16px",
          "max-width": "768px",
        }}
      >
        <Show
          when={!isEmpty()}
          fallback={
            <div
              data-testid="plans-panel-empty"
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                height: "100%",
                color: "var(--dim)",
                "font-size": "12px",
              }}
            >
              Select a plan to view
            </div>
          }
        >
          <For each={sections()}>
            {(section, i) => {
              const ai = isAiAuthor(section.author);
              const borderColor = section.author
                ? ai
                  ? "var(--ai-color)"
                  : "var(--human-color)"
                : "transparent";
              const bgColor = section.author
                ? ai
                  ? "var(--ai-bg)"
                  : "var(--human-bg)"
                : "transparent";
              return (
                <div
                  data-testid="plans-panel-section"
                  data-section-author={section.author ?? ""}
                  data-section-index={i()}
                  class="plans-panel-content"
                  style={{
                    "border-left": `2px solid ${borderColor}`,
                    "padding-left": "12px",
                    "margin-bottom": "4px",
                    background: bgColor,
                    "border-radius": "2px",
                  }}
                >
                  <Show when={section.author && section.heading}>
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "8px",
                        "margin-bottom": "4px",
                      }}
                    >
                      <span
                        data-testid="plans-panel-author-badge"
                        style={{
                          "font-size": "9px",
                          padding: "1px 4px",
                          "border-radius": "2px",
                          color: ai ? "var(--ai-color)" : "var(--human-color)",
                          background: ai ? "var(--ai-badge)" : "var(--human-badge)",
                        }}
                      >
                        {section.author}
                      </span>
                      <Show when={section.authorAt && formatAuthorTime(section.authorAt)}>
                        {(t) => (
                          <span style={{ "font-size": "9px", color: "var(--dimmer)" }}>{t()}</span>
                        )}
                      </Show>
                    </div>
                  </Show>
                  <div
                    data-testid="plans-panel-markdown"
                    // eslint-disable-next-line solid/no-innerhtml
                    innerHTML={section.html}
                  />
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
