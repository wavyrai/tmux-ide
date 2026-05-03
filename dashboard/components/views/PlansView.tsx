"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { useTheme } from "next-themes";
import {
  fetchPlan,
  fetchPlans,
  fetchProject,
  markPlanDone,
  updatePlanStatus,
  type PlanData,
  type PlanStatus,
  type PlanSummary,
} from "@/lib/api";
import type { Task } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";
import { useToasts } from "@/lib/useToasts";
import { AuthorshipBar } from "@/components/AuthorshipBar";
import {
  diffStats,
  parsePlanDocument,
  type PlanFrontmatter,
  type TocItem,
} from "@/lib/planMarkdown";

interface PlansViewProps {
  sessionName: string;
}

const STATUS_COLORS: Record<PlanStatus, string> = {
  "in-progress": "var(--yellow)",
  pending: "var(--dim)",
  done: "var(--green)",
  archived: "var(--dimmer)",
};

const STATUS_ORDER: PlanStatus[] = ["pending", "in-progress", "done"];
const highlightCache = new Map<string, string>();

function activePlanKey(project: string): string {
  return `tmux-ide.plans.active.${project}`;
}

function formatDate(value: string | number | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function planFilename(plan: PlanSummary): string {
  return plan.path || `${plan.name}.md`;
}

function statusPill(status: PlanStatus): string {
  if (status === "in-progress") return "in progress";
  return status;
}

function chip(value: ReactNode, key: string) {
  return (
    <span
      key={key}
      className="inline-flex h-5 max-w-52 items-center truncate border border-[var(--border)] px-1.5 text-[10px] text-[var(--fg-secondary)]"
    >
      {value}
    </span>
  );
}

function metadataChips(frontmatter: PlanFrontmatter): ReactNode[] {
  const chips: ReactNode[] = [];
  if (frontmatter.owner) chips.push(chip(`owner ${frontmatter.owner}`, "owner"));
  if (frontmatter.effort) chips.push(chip(`effort ${frontmatter.effort}`, "effort"));
  if (frontmatter.due) chips.push(chip(`due ${frontmatter.due}`, "due"));
  for (const tag of frontmatter.tags ?? []) chips.push(chip(`#${tag}`, `tag:${tag}`));
  return chips;
}

function taskLabel(raw: string): string {
  return raw.startsWith("#") ? raw.slice(1) : raw.replace(/^\[|\]$/g, "");
}

function renderInlineTasks(
  node: ReactNode,
  tasksById: Map<string, Task>,
  onTaskClick: () => void,
): ReactNode {
  if (typeof node !== "string") return node;
  const parts = node.split(/(\[task-\d+\]|#task-\d+)/gi);
  return parts.map((part, index) => {
    if (!/^(\[task-\d+\]|#task-\d+)$/i.test(part)) return part;
    const id = taskLabel(part).toLowerCase();
    const task = tasksById.get(id);
    return (
      <button
        key={`${id}-${index}`}
        type="button"
        title={task?.description || task?.title || id}
        onClick={onTaskClick}
        className="mx-0.5 inline-flex h-5 items-center border border-[var(--border)] px-1.5 text-[10px] text-[var(--cyan)] hover:border-[var(--cyan)]"
      >
        {id}
        {task?.title ? ` · ${task.title}` : ""}
      </button>
    );
  });
}

function DiffBlock({ code }: { code: string }) {
  const stats = diffStats(code);
  return (
    <div className="mb-3 overflow-hidden border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex h-6 items-center gap-3 border-b border-[var(--border-weak)] px-2 text-[10px] text-[var(--dim)]">
        <span className="text-[var(--green)]">+{stats.additions}</span>
        <span className="text-[var(--red)]">-{stats.deletions}</span>
        <span>diff</span>
      </div>
      <pre className="overflow-x-auto p-0 text-[11px] leading-5">
        {code.split("\n").map((line, index) => {
          const added = line.startsWith("+") && !line.startsWith("+++");
          const removed = line.startsWith("-") && !line.startsWith("---");
          return (
            <div
              key={index}
              className="grid grid-cols-[3ch_1fr]"
              style={{
                background: added
                  ? "var(--diff-add-bg)"
                  : removed
                    ? "var(--diff-del-bg)"
                    : "transparent",
                color: added
                  ? "var(--diff-add-text)"
                  : removed
                    ? "var(--diff-del-text)"
                    : "var(--fg)",
              }}
            >
              <span className="select-none border-r border-[var(--border-weak)] text-center text-[var(--dimmer)]">
                {added ? "+" : removed ? "-" : ""}
              </span>
              <code className="whitespace-pre px-2">{line}</code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { resolvedTheme } = useTheme();
  const { push } = useToasts();
  const [html, setHtml] = useState("");
  const theme = resolvedTheme === "light" ? "github-light" : "github-dark";

  useEffect(() => {
    let active = true;
    const cacheKey = `${theme}:${language}:${code}`;
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      setHtml(cached);
      return;
    }
    import("shiki")
      .then(({ codeToHtml, bundledLanguages, bundledThemes }) =>
        codeToHtml(code, {
          lang: language in bundledLanguages ? language : "text",
          theme: theme in bundledThemes ? theme : "github-dark",
        }),
      )
      .then((value) => {
        highlightCache.set(cacheKey, value);
        if (active) setHtml(value);
      })
      .catch(() => {
        if (active) setHtml("");
      });
    return () => {
      active = false;
    };
  }, [code, language, theme]);

  async function copy() {
    await navigator.clipboard?.writeText(code);
    push({ kind: "success", title: "Copied", durationMs: 1200 });
  }

  if (language === "diff") return <DiffBlock code={code} />;

  return (
    <div className="group relative mb-3 overflow-hidden border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex h-6 items-center justify-between border-b border-[var(--border-weak)] px-2">
        <span className="text-[10px] text-[var(--dim)]">{language || "text"}</span>
        <button
          type="button"
          data-testid="code-copy-button"
          onClick={copy}
          className="opacity-0 transition-opacity text-[10px] text-[var(--dim)] hover:text-[var(--accent)] group-hover:opacity-100"
        >
          copy
        </button>
      </div>
      {html ? (
        <div
          className="[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-3 [&_code]:font-[var(--font-mono)] [&_code]:text-[11px]"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[11px]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function Toc({ toc, activeId }: { toc: TocItem[]; activeId: string }) {
  if (toc.length === 0) return <div className="text-[11px] text-[var(--dim)]">no headings</div>;
  return (
    <nav data-testid="plans-toc" className="space-y-1">
      {toc.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() =>
            document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          className={`block w-full truncate text-left text-[11px] transition-colors ${
            activeId === item.id
              ? "text-[var(--accent)]"
              : "text-[var(--dim)] hover:text-[var(--fg)]"
          }`}
          style={{ paddingLeft: `${(item.level - 1) * 10}px` }}
        >
          {item.text}
        </button>
      ))}
    </nav>
  );
}

export function PlansView({ sessionName }: PlansViewProps) {
  const fetcher = useCallback(() => fetchPlans(sessionName), [sessionName]);
  const { data: plans, loading, refresh } = usePolling<PlanSummary[]>(fetcher, 5000);
  const { push } = useToasts();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData>({ content: "", authorship: null });
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [tasksById, setTasksById] = useState(new Map<string, Task>());
  const [activeHeading, setActiveHeading] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadedFileRef = useRef<string | null>(null);

  const selectedPlan = useMemo(
    () => plans?.find((plan) => planFilename(plan) === selectedFile) ?? null,
    [plans, selectedFile],
  );
  const parsed = useMemo(() => parsePlanDocument(planData.content), [planData.content]);
  const status = parsed.frontmatter.status ?? selectedPlan?.status ?? "pending";
  const title = parsed.frontmatter.title ?? selectedPlan?.title ?? selectedPlan?.name ?? "Plan";
  const selectedUpdated = selectedPlan?.updated ?? selectedPlan?.completed ?? null;

  useEffect(() => {
    if (!plans || plans.length === 0 || selectedFile) return;
    const stored =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(activePlanKey(sessionName));
    const next = plans.find((plan) => planFilename(plan) === stored) ?? plans[0];
    if (next) setSelectedFile(planFilename(next));
  }, [plans, selectedFile, sessionName]);

  useEffect(() => {
    if (!selectedFile || typeof window === "undefined") return;
    window.localStorage.setItem(activePlanKey(sessionName), selectedFile);
  }, [selectedFile, sessionName]);

  useEffect(() => {
    let active = true;
    fetchProject(sessionName).then((project) => {
      if (!active) return;
      setTasksById(new Map((project?.tasks ?? []).map((task) => [task.id.toLowerCase(), task])));
    });
    return () => {
      active = false;
    };
  }, [sessionName]);

  useEffect(() => {
    if (!selectedFile) return;
    let active = true;
    const isInitialLoad = loadedFileRef.current !== selectedFile;
    const previousScrollTop = scrollRef.current?.scrollTop ?? 0;
    if (isInitialLoad) setLoadingPlan(true);
    fetchPlan(sessionName, selectedFile)
      .then((data) => {
        if (!active) return;
        loadedFileRef.current = selectedFile;
        setPlanData(data);
        if (!isInitialLoad) {
          requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = previousScrollTop;
          });
        }
      })
      .finally(() => {
        if (active) setLoadingPlan(false);
      });
    return () => {
      active = false;
    };
  }, [selectedFile, selectedUpdated, sessionName]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || parsed.toc.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActiveHeading(visible.target.id);
      },
      { root, rootMargin: "-12% 0px -70% 0px" },
    );
    for (const item of parsed.toc) {
      const element = document.getElementById(item.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [parsed.toc, planData.content]);

  async function cycleStatus() {
    if (!selectedPlan) return;
    const next =
      STATUS_ORDER[(STATUS_ORDER.indexOf(status) + 1) % STATUS_ORDER.length] ?? "pending";
    const ok =
      next === "done"
        ? await markPlanDone(sessionName, selectedPlan.name)
        : await updatePlanStatus(sessionName, selectedPlan.name, next);
    if (ok) {
      push({ kind: "success", title: `Plan marked ${statusPill(next)}`, durationMs: 1600 });
      refresh();
      const refreshed = await fetchPlan(sessionName, planFilename(selectedPlan));
      setPlanData(refreshed);
    }
  }

  function openTaskView() {
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  if (loading && !plans) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--dim)]">
        Loading plans...
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--dim)]">
        No plan files found in plans/
      </div>
    );
  }

  return (
    <div data-testid="plans-view" className="flex min-h-0 flex-1 bg-[var(--bg)]">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-weak)]">
        <div className="flex h-8 items-center border-b border-[var(--border)] px-3 text-[11px] text-[var(--dim)]">
          plans
          <span className="ml-auto">{plans.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {plans.map((plan) => {
            const file = planFilename(plan);
            const selected = file === selectedFile;
            return (
              <button
                key={file}
                type="button"
                onClick={() => setSelectedFile(file)}
                className={`w-full border-b border-[var(--border-weak)] px-3 py-2 text-left transition-colors ${
                  selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg)]">
                    {plan.title || plan.name}
                  </span>
                  <span
                    className="shrink-0 text-[10px]"
                    style={{ color: STATUS_COLORS[plan.status] }}
                  >
                    {statusPill(plan.status)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--dimmer)]">
                  <span className="truncate">{plan.name}</span>
                  {plan.completed && <span>{formatDate(plan.completed)}</span>}
                  {plan.owner && <span className="truncate">@{plan.owner}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1">
        <section ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
          {loadingPlan ? (
            <div className="flex h-full items-center justify-center text-[var(--dim)]">
              loading...
            </div>
          ) : (
            <article className="mx-auto max-w-4xl px-6 py-5">
              <header className="mb-5 border-b border-[var(--border)] pb-4">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-[20px] font-semibold text-[var(--fg)]">{title}</h1>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {metadataChips(parsed.frontmatter)}
                      {(parsed.frontmatter.related ?? []).map((task) =>
                        chip(
                          <button
                            type="button"
                            onClick={openTaskView}
                            className="text-[var(--cyan)]"
                          >
                            {task}
                          </button>,
                          `related:${task}`,
                        ),
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={cycleStatus}
                    className="shrink-0 border border-[var(--border)] px-2 py-1 text-[11px] hover:border-[var(--accent)]"
                    style={{ color: STATUS_COLORS[status] }}
                  >
                    {statusPill(status)}
                  </button>
                </div>
              </header>

              <div className="plan-content">
                <Markdown
                  components={{
                    h1: ({ children }) => {
                      const text = String(children);
                      const item = parsed.toc.find(
                        (entry) => entry.text === text && entry.level === 1,
                      );
                      return <h1 id={item?.id}>{children}</h1>;
                    },
                    h2: ({ children }) => {
                      const text = String(children);
                      const matching = parsed.toc.filter(
                        (entry) => entry.text === text && entry.level === 2,
                      );
                      return <h2 id={matching[0]?.id}>{children}</h2>;
                    },
                    h3: ({ children }) => {
                      const text = String(children);
                      const matching = parsed.toc.filter(
                        (entry) => entry.text === text && entry.level === 3,
                      );
                      return <h3 id={matching[0]?.id}>{children}</h3>;
                    },
                    p: ({ children }) => (
                      <p>
                        {Array.isArray(children)
                          ? children.map((child) =>
                              renderInlineTasks(child, tasksById, openTaskView),
                            )
                          : renderInlineTasks(children, tasksById, openTaskView)}
                      </p>
                    ),
                    li: ({ children }) => (
                      <li>
                        {Array.isArray(children)
                          ? children.map((child) =>
                              renderInlineTasks(child, tasksById, openTaskView),
                            )
                          : renderInlineTasks(children, tasksById, openTaskView)}
                      </li>
                    ),
                    code: ({ className, children }) => {
                      const code = String(children).replace(/\n$/, "");
                      const match = /language-(\w+)/.exec(className ?? "");
                      if (!match) return <code>{children}</code>;
                      return <CodeBlock language={match[1] ?? "text"} code={code} />;
                    },
                  }}
                >
                  {parsed.content}
                </Markdown>
              </div>

              <div className="mt-8 border-t border-[var(--border)] pt-3">
                <AuthorshipBar authorship={planData.authorship} />
              </div>
            </article>
          )}
        </section>

        <aside className="hidden w-56 shrink-0 border-l border-[var(--border)] bg-[var(--bg-weak)] p-3 lg:block">
          <div className="sticky top-3">
            <div className="mb-2 text-[10px] uppercase text-[var(--dimmer)]">outline</div>
            <Toc toc={parsed.toc} activeId={activeHeading} />
          </div>
        </aside>
      </main>
    </div>
  );
}
