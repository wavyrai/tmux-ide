"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import { useTheme } from "next-themes";
import {
  createPlan,
  fetchPlan,
  fetchPlans,
  fetchProject,
  markPlanDone,
  savePlanContent,
  updatePlanStatus,
  type PlanData,
  type PlanStatus,
  type PlanSummary,
} from "@/lib/api";
import { PlansRailBridge } from "@/components/plans-rail-bridge";
import type { Task } from "@/lib/types";
import { Persist } from "@/lib/persist";
import { usePolling } from "@/lib/usePolling";
import { useToasts } from "@/lib/useToasts";
import { NavigatorPortal } from "@/lib/useNavigatorSlot";
import { AuthorshipBar } from "@/components/AuthorshipBar";
import { MarkdownEditor } from "./MarkdownEditor";
import {
  EmptyState,
  Panel,
  PanelBody,
  SkeletonText,
  StatusPill,
  SurfaceCard,
  type StatusPillVariant,
} from "@/components/ui";
import {
  diffStats,
  parsePlanDocument,
  type PlanFrontmatter,
  type TocItem,
} from "./planMarkdown";

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
const PLAN_RAIL_STATUSES: PlanStatus[] = ["in-progress", "pending", "done", "archived"];
const highlightCache = new Map<string, string>();
type PlanSort = "recent" | "status" | "title" | "owner";
type PlanRailCollapseState = Record<string, Partial<Record<PlanStatus, boolean>>>;
type PlanEditingState = Record<string, boolean>;
const planRailPersist = Persist.global<PlanRailCollapseState>("tmux-ide.plans.rail", ["v1"], {});
const planEditingPersist = Persist.global<PlanEditingState>("tmux-ide.plans.editing", ["v1"], {});

const MOBILE_QUERY = "(max-width: 767px)";

function activePlanKey(project: string): string {
  return `tmux-ide.plans.active.${project}`;
}

function planEditingKey(project: string, filename: string): string {
  return `${project}:${filename}`;
}

function formatRelativeTime(value: string | number | null | undefined): string {
  if (!value) return "not updated";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return String(value);
  const ms = Date.now() - time;
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function planFilename(plan: PlanSummary): string {
  return plan.path || `${plan.name}.md`;
}

function slugifyPlanTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "new-plan";
}

function statusPill(status: PlanStatus): string {
  if (status === "in-progress") return "in progress";
  return status;
}

function statusVariant(status: PlanStatus): StatusPillVariant {
  if (status === "done") return "done";
  if (status === "in-progress") return "active";
  if (status === "archived") return "archived";
  return "pending";
}

function planOwner(plan: PlanSummary): string {
  return plan.owner?.trim() || "unowned";
}

function planTags(plan: PlanSummary): string[] {
  const tags = (plan as PlanSummary & { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

function planTimestamp(plan: PlanSummary): number {
  const raw = plan.updated ?? plan.completed;
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function chip(value: ReactNode, key: string) {
  return (
    <span
      key={key}
      className="inline-flex h-5 max-w-52 items-center truncate rounded-md border border-[var(--border)] px-1.5 text-[10px] text-[var(--fg-secondary)]"
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
    <div className="mb-3 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
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
    <div className="group relative mb-3 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
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

/**
 * Tracks the navigator-vs-mobile breakpoint. Returns `true` for viewports
 * narrow enough that the navigator slot collapses (PlansView then renders
 * the rail inline in its panel and uses `mobileDetailOpen` to switch
 * between rail and detail). Always `false` during SSR and the first
 * render so server HTML matches.
 */
function useIsMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isMobile;
}


interface PlanDetailProps {
  sessionName: string;
  plans: PlanSummary[];
  selectedPlan: PlanSummary | null;
  selectedFile: string | null;
  planData: PlanData;
  setPlanData: React.Dispatch<React.SetStateAction<PlanData>>;
  parsed: ReturnType<typeof parsePlanDocument>;
  loadingPlan: boolean;
  editing: boolean;
  setEditing: (filename: string, value: boolean) => void;
  editContent: string;
  setEditContent: (value: string) => void;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
  reloadPlan: PlanData | null;
  reloadFromDisk: () => void;
  cycleStatus: () => Promise<void> | void;
  tasksById: Map<string, Task>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  activeHeading: string;
  onMobileBack: () => void;
  showMobileBack: boolean;
}

/**
 * Right detail: plan header, status pill, edit toggle, markdown body
 * (Markdown / MarkdownEditor), authorship footer, and outline aside.
 */
function PlanDetail({
  selectedFile,
  plans,
  selectedPlan,
  planData,
  parsed,
  loadingPlan,
  editing,
  setEditing,
  editContent,
  setEditContent,
  saveState,
  reloadPlan,
  reloadFromDisk,
  cycleStatus,
  tasksById,
  scrollRef,
  activeHeading,
  onMobileBack,
  showMobileBack,
}: PlanDetailProps) {
  const status = parsed.frontmatter.status ?? selectedPlan?.status ?? "pending";
  const title = parsed.frontmatter.title ?? selectedPlan?.title ?? selectedPlan?.name ?? "Plan";

  function openTaskView() {
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  if (plans.length === 0) return null;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
      {showMobileBack && (
        <div className="flex h-9 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-weak)] px-2 sm:hidden">
          <button
            type="button"
            onClick={onMobileBack}
            className="flex h-7 items-center gap-1 px-2 text-[12px] text-[var(--fg-secondary)] hover:text-[var(--accent)]"
            aria-label="Back to plans"
          >
            ‹ plans
          </button>
        </div>
      )}
      <section ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {loadingPlan ? (
          <div className="mx-auto max-w-4xl space-y-5 px-6 py-5">
            <SurfaceCard>
              <SkeletonText lines={6} />
            </SurfaceCard>
            <SurfaceCard>
              <SkeletonText lines={10} />
            </SurfaceCard>
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
                  onClick={() => void cycleStatus()}
                  className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] hover:border-[var(--accent)]"
                >
                  <StatusPill variant={statusVariant(status)} label={statusPill(status)} />
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {editing && (
                    <span
                      data-testid="plan-save-state"
                      className="text-[10px] text-[var(--dimmer)]"
                    >
                      {saveState === "dirty"
                        ? "unsaved"
                        : saveState === "saving"
                          ? "saving..."
                          : saveState === "saved"
                            ? "saved"
                            : saveState === "error"
                              ? "save failed"
                              : ""}
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid="plan-edit-toggle"
                    onClick={() => selectedFile && setEditing(selectedFile, !editing)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      editing
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--fg)]"
                    }`}
                  >
                    {editing ? "View" : "Edit"}
                  </button>
                </div>
              </div>
            </header>

            {editing ? (
              <div className="flex min-h-[520px] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)]">
                {reloadPlan && (
                  <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--border)] px-3 text-[11px]">
                    <span className="text-[var(--yellow)]">Plan changed on disk</span>
                    <button
                      type="button"
                      onClick={reloadFromDisk}
                      className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      Reload from disk?
                    </button>
                  </div>
                )}
                <MarkdownEditor
                  key={selectedFile}
                  value={editContent}
                  onChange={setEditContent}
                  onSave={(value) => setEditContent(value)}
                />
              </div>
            ) : (
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
            )}

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
  );
}

export function PlansView({ sessionName }: PlansViewProps) {
  const fetcher = useCallback(() => fetchPlans(sessionName), [sessionName]);
  const { data: plans, loading, refresh } = usePolling<PlanSummary[]>(fetcher, 10000);
  const { push } = useToasts();
  const isMobile = useIsMobileLayout();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData>({ content: "", authorship: null });
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [tasksById, setTasksById] = useState(new Map<string, Task>());
  const [activeHeading, setActiveHeading] = useState("");
  const [planQuery, setPlanQuery] = useState("");
  const [planSort, setPlanSort] = useState<PlanSort>("recent");
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Partial<Record<PlanStatus, boolean>>>({});
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">(
    "idle",
  );
  const [reloadPlan, setReloadPlan] = useState<PlanData | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadedFileRef = useRef<string | null>(null);
  const loadedMtimeRef = useRef<number | null>(null);
  const savedContentRef = useRef("");
  const editingRef = useRef(false);
  const dirtyRef = useRef(false);

  const selectedPlan = useMemo(
    () => plans?.find((plan) => planFilename(plan) === selectedFile) ?? null,
    [plans, selectedFile],
  );
  const parsed = useMemo(() => parsePlanDocument(planData.content), [planData.content]);
  const selectedUpdated = selectedPlan?.updated ?? selectedPlan?.completed ?? null;
  const dirty = editContent !== savedContentRef.current;

  const visiblePlans = useMemo(() => {
    const query = planQuery.trim().toLowerCase();
    const filtered = (plans ?? []).filter((plan) => {
      if (!query) return true;
      const searchable = [plan.name, plan.title, plan.status, plan.owner ?? "", ...planTags(plan)]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (planSort === "recent") return planTimestamp(b) - planTimestamp(a);
      if (planSort === "status") {
        return (
          PLAN_RAIL_STATUSES.indexOf(a.status) - PLAN_RAIL_STATUSES.indexOf(b.status) ||
          a.title.localeCompare(b.title)
        );
      }
      if (planSort === "owner") {
        return planOwner(a).localeCompare(planOwner(b)) || a.title.localeCompare(b.title);
      }
      return a.title.localeCompare(b.title);
    });
  }, [planQuery, planSort, plans]);

  useEffect(() => {
    if (!plans || plans.length === 0 || selectedFile) return;
    const stored =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(activePlanKey(sessionName));
    const next = plans.find((plan) => planFilename(plan) === stored) ?? plans[0];
    if (next) {
      setSelectedFile(planFilename(next));
      setMobileDetailOpen(true);
    }
  }, [plans, selectedFile, sessionName]);

  useEffect(() => {
    if (!selectedFile || typeof window === "undefined") return;
    window.localStorage.setItem(activePlanKey(sessionName), selectedFile);
  }, [selectedFile, sessionName]);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    dirtyRef.current = dirty;
    if (editing && dirty) setSaveState("dirty");
  }, [dirty, editing]);

  useEffect(() => {
    if (!selectedFile) return;
    const stored = planEditingPersist.read();
    setEditing(Boolean(stored[planEditingKey(sessionName, selectedFile)]));
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
        const nextMtime = data.mtime ?? null;
        const externalChange =
          !isInitialLoad &&
          nextMtime !== null &&
          loadedMtimeRef.current !== null &&
          nextMtime !== loadedMtimeRef.current;
        if (externalChange && editingRef.current && dirtyRef.current) {
          setReloadPlan(data);
          return;
        }
        loadedFileRef.current = selectedFile;
        setPlanData(data);
        setEditContent(data.content);
        savedContentRef.current = data.content;
        loadedMtimeRef.current = nextMtime;
        setReloadPlan(null);
        setSaveState("idle");
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
    if (!selectedFile || !editing || !dirty) return;
    setSaveState("dirty");
    const timer = setTimeout(() => {
      setSaveState("saving");
      savePlanContent(sessionName, selectedFile, editContent)
        .then((result) => {
          if (!result.ok) {
            setSaveState("error");
            push({
              kind: "error",
              title: "Failed to save plan",
              body: selectedFile,
              scope: { project: sessionName },
            });
            return;
          }
          savedContentRef.current = editContent;
          loadedMtimeRef.current = result.mtime ?? loadedMtimeRef.current;
          setPlanData((current) => ({ ...current, content: editContent, mtime: result.mtime }));
          setSaveState("saved");
          refresh();
        })
        .catch(() => {
          setSaveState("error");
          push({
            kind: "error",
            title: "Failed to save plan",
            body: selectedFile,
            scope: { project: sessionName },
          });
        });
    }, 800);
    return () => clearTimeout(timer);
  }, [dirty, editContent, editing, push, refresh, selectedFile, sessionName]);

  useEffect(() => {
    setCollapsedGroups(planRailPersist.read()[sessionName] ?? {});
  }, [sessionName]);

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

  const status = parsed.frontmatter.status ?? selectedPlan?.status ?? "pending";

  const cycleStatus = useCallback(async () => {
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
  }, [push, refresh, selectedPlan, sessionName, status]);

  const togglePlanGroup = useCallback(
    (groupStatus: PlanStatus) => {
      setCollapsedGroups((current) => {
        const next = { ...current, [groupStatus]: !current[groupStatus] };
        const stored = planRailPersist.read();
        planRailPersist.write({ ...stored, [sessionName]: next });
        return next;
      });
    },
    [sessionName],
  );

  const setPlanEditing = useCallback(
    (filename: string, value: boolean) => {
      const stored = planEditingPersist.read();
      planEditingPersist.write({ ...stored, [planEditingKey(sessionName, filename)]: value });
      setEditing(value);
    },
    [sessionName],
  );

  const reloadFromDisk = useCallback(() => {
    if (!reloadPlan) return;
    setPlanData(reloadPlan);
    setEditContent(reloadPlan.content);
    savedContentRef.current = reloadPlan.content;
    loadedMtimeRef.current = reloadPlan.mtime ?? loadedMtimeRef.current;
    setReloadPlan(null);
    setSaveState("idle");
  }, [reloadPlan]);

  const createPlanStub = useCallback(async () => {
    const title = "New Plan";
    const filename = `${Date.now()}-${slugifyPlanTitle(title)}.md`;
    const content = `---\ntitle: ${title}\nstatus: pending\n---\n# ${title}\n\n`;
    const result = await createPlan(sessionName, filename, content);
    if (!result.ok) {
      push({
        kind: "error",
        title: "Failed to create plan",
        body: filename,
        scope: { project: sessionName },
      });
      return;
    }
    setSelectedFile(filename);
    setMobileDetailOpen(true);
    setPlanEditing(filename, true);
    setPlanData({ content, authorship: null, mtime: result.mtime ?? null });
    setEditContent(content);
    savedContentRef.current = content;
    loadedMtimeRef.current = result.mtime ?? null;
    setSaveState("saved");
    refresh();
  }, [push, refresh, sessionName, setPlanEditing]);

  const handleSelect = useCallback((file: string) => {
    setSelectedFile(file);
    setMobileDetailOpen(true);
  }, []);

  if (loading && !plans) {
    return (
      <Panel>
        <PanelBody className="space-y-5 p-4">
          <SurfaceCard>
            <SkeletonText lines={6} />
          </SurfaceCard>
          <SurfaceCard>
            <SkeletonText lines={10} />
          </SurfaceCard>
        </PanelBody>
      </Panel>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <Panel>
        <PanelBody className="space-y-5 p-4">
          <EmptyState
            title="No plan files found in plans/"
            action={
              <button
                type="button"
                onClick={() => void createPlanStub()}
                className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-strong)] px-3 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                New plan
              </button>
            }
          />
        </PanelBody>
      </Panel>
    );
  }

  // The Solid `PlansRailBridge` is the only render path after U2 retired
  // the React `PlanListNavigator` + `?plans=solid` flag.
  const navigator = (
    <PlansRailBridge
      sessionName={sessionName}
      selectedFile={selectedFile}
      onSelect={handleSelect}
      onCreate={() => void createPlanStub()}
    />
  );

  // On mobile, the navigator slot collapses (the layout hides it under md).
  // PlansView then renders the rail inline in its panel and uses
  // mobileDetailOpen to switch between rail and detail. On desktop, the
  // rail goes into the navigator slot via NavigatorPortal and the panel
  // shows only the detail.
  if (isMobile) {
    return (
      <Panel testId="plans-view">
        {mobileDetailOpen ? (
          <PlanDetail
            sessionName={sessionName}
            plans={plans}
            selectedPlan={selectedPlan}
            selectedFile={selectedFile}
            planData={planData}
            setPlanData={setPlanData}
            parsed={parsed}
            loadingPlan={loadingPlan}
            editing={editing}
            setEditing={setPlanEditing}
            editContent={editContent}
            setEditContent={setEditContent}
            saveState={saveState}
            reloadPlan={reloadPlan}
            reloadFromDisk={reloadFromDisk}
            cycleStatus={cycleStatus}
            tasksById={tasksById}
            scrollRef={scrollRef}
            activeHeading={activeHeading}
            onMobileBack={() => setMobileDetailOpen(false)}
            showMobileBack
          />
        ) : (
          <div className="flex min-h-0 flex-1">{navigator}</div>
        )}
      </Panel>
    );
  }

  return (
    <Panel testId="plans-view">
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[280px] shrink-0 flex-col border-r border-[var(--border-weak)] bg-[var(--bg-weak)] sm:flex">
          {navigator}
        </aside>
        <PlanDetail
          sessionName={sessionName}
          plans={plans}
          selectedPlan={selectedPlan}
          selectedFile={selectedFile}
          planData={planData}
          setPlanData={setPlanData}
          parsed={parsed}
          loadingPlan={loadingPlan}
          editing={editing}
          setEditing={setPlanEditing}
          editContent={editContent}
          setEditContent={setEditContent}
          saveState={saveState}
          reloadPlan={reloadPlan}
          reloadFromDisk={reloadFromDisk}
          cycleStatus={cycleStatus}
          tasksById={tasksById}
          scrollRef={scrollRef}
          activeHeading={activeHeading}
          onMobileBack={() => setMobileDetailOpen(false)}
          showMobileBack={false}
        />
      </div>
    </Panel>
  );
}
