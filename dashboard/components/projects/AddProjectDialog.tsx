"use client";

import { ArrowLeft, CheckCircle2, FolderPlus, GitBranch, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  fetchProjectTemplates,
  initProject,
  inspectDirectory,
  onboardProject,
  registerProject,
  type OnboardProjectInput,
  type ProjectTemplate,
  type RegisteredProject,
} from "@/lib/api";
import {
  closeAddProjectDialog,
  setAddProjectDialogOpen,
  useAddProjectDialog,
} from "@/lib/addProjectDialogStore";
import { setNavigation } from "@/lib/navigation";
import { useProjects, refreshProjects } from "@/lib/projectStore";
import { useSettings } from "@/lib/useSettings";
import { useToasts } from "@/lib/useToasts";
import { subscribeGlobal, type ServerFrame } from "@/lib/wsBus";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import {
  activeFooterKind,
  chunksToConsoleText,
  commitDir,
  defaultFlowState,
  deriveInitTabSubmit,
  deriveNameFromDir,
  deriveOpenTabSubmit,
  gotoNextAfterInspect,
  gotoPick,
  gotoTab,
  initJobReducer,
  isInitDoneFrame,
  isInitErrorFrame,
  normalizeDir,
  parseInitOutputFrame,
  validateDir,
  validateName,
  type AddProjectFlowState,
  type AddProjectTab,
  type InitJobState,
} from "./AddProjectDialog.logic";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { OnboardingWizard } from "./OnboardingWizard";

/**
 * Three-tab dialog for adding a project to the registry.
 *
 *   - "open"  — point at an existing tmux-ide directory and register it.
 *   - "init"  — pick a directory + template, server runs `tmux-ide init`.
 *   - "clone" — coming soon (server-side support gated by Agent 1).
 *
 * Each tab is a panel stack — `pick` first, then `confirm`/`onboard`/`init`
 * after the user commits a directory. Only one panel is visible at a time
 * so the dialog never overflows the viewport. The OnboardingWizard owns
 * its own footer when active; otherwise the dialog renders its own.
 *
 * Rendering only — validators, the init job state machine, frame parsers,
 * and the panel-step state machine all live in `AddProjectDialog.logic.ts`.
 */
export function AddProjectDialog() {
  const { open, initialTab } = useAddProjectDialog();
  const [flow, setFlow] = useState<AddProjectFlowState>(() => defaultFlowState(initialTab));

  // Reset when the singleton open transitions false -> true.
  useEffect(() => {
    if (open) setFlow(defaultFlowState(initialTab));
  }, [open, initialTab]);

  const onTabChange = useCallback(
    (tab: AddProjectTab) => setFlow((s) => gotoTab(s, tab)),
    [],
  );

  return (
    <Dialog open={open} onOpenChange={setAddProjectDialogOpen}>
      <DialogContent
        data-testid="add-project-dialog"
        className="flex max-h-[min(720px,calc(100vh-80px))] w-[min(640px,calc(100vw-32px))] flex-col p-0"
      >
        <DialogHeader className="shrink-0 border-b border-[var(--border-weak)] px-4 pt-4 pb-3">
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            Open an existing tmux-ide project or initialize a new one in a directory.
          </DialogDescription>
          {flow.step !== "pick" && flow.selectedDir && (
            <Breadcrumb dir={flow.selectedDir} onChange={() => setFlow(gotoPick)} />
          )}
        </DialogHeader>

        <div className="flex shrink-0 border-b border-[var(--border-weak)] px-4">
          <TabButton
            active={flow.tab === "open"}
            onClick={() => onTabChange("open")}
            icon={<FolderPlus aria-hidden="true" size={13} />}
            label="Open existing"
            testId="add-project-tab-open"
          />
          <TabButton
            active={flow.tab === "init"}
            onClick={() => onTabChange("init")}
            icon={<Sparkles aria-hidden="true" size={13} />}
            label="Initialize"
            testId="add-project-tab-init"
          />
          <TabButton
            active={flow.tab === "clone"}
            onClick={() => onTabChange("clone")}
            icon={<GitBranch aria-hidden="true" size={13} />}
            label="Clone from Git"
            testId="add-project-tab-clone"
          />
        </div>

        <div
          data-testid="add-project-body"
          data-footer-kind={activeFooterKind(flow)}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3"
        >
          {flow.tab === "open" && <OpenExistingTab flow={flow} setFlow={setFlow} />}
          {flow.tab === "init" && <InitializeTab flow={flow} setFlow={setFlow} />}
          {flow.tab === "clone" && <CloneTab />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface BreadcrumbProps {
  dir: string;
  onChange: () => void;
}

function Breadcrumb({ dir, onChange }: BreadcrumbProps) {
  return (
    <div
      data-testid="add-project-breadcrumb"
      className="mt-2 flex items-center gap-2 text-[11px] text-[var(--dim)]"
    >
      <span className="truncate font-mono text-[var(--fg)]" title={dir}>
        {dir}
      </span>
      <button
        type="button"
        data-testid="add-project-breadcrumb-change"
        onClick={onChange}
        className="flex shrink-0 items-center gap-1 rounded border border-[var(--border-weak)] px-1.5 py-0.5 text-[10px] text-[var(--fg)] hover:bg-[var(--surface)] focus-visible:focus-ring"
      >
        <ArrowLeft aria-hidden="true" size={10} />
        Change
      </button>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testId: string;
}

function TabButton({ active, onClick, icon, label, testId }: TabButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] transition-colors ${
        active
          ? "border-[var(--accent)] text-[var(--fg)]"
          : "border-transparent text-[var(--dim)] hover:text-[var(--fg)]"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ---------- Open existing ----------

interface TabPanelProps {
  flow: AddProjectFlowState;
  setFlow: React.Dispatch<React.SetStateAction<AddProjectFlowState>>;
}

function OpenExistingTab({ flow, setFlow }: TabPanelProps) {
  const settings = useSettings();
  const { projects } = useProjects();
  const { push } = useToasts();
  const baseDir = settings.general.addProjectBaseDirectory ?? "";

  const initialDir = flow.selectedDir ?? baseDir;
  const [rawDir, setRawDir] = useState(initialDir);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dir = normalizeDir(rawDir, baseDir);
  const dirValidation = validateDir(rawDir || "/");

  const inspect = flow.inspect;

  const probeAt = useCallback(
    async (path: string) => {
      setProbing(true);
      setProbeError(null);
      try {
        const result = await inspectDirectory(path);
        setFlow((s) => gotoNextAfterInspect({ ...s, selectedDir: path }, result));
      } catch (error) {
        setProbeError(error instanceof Error ? error.message : "Inspect failed");
      } finally {
        setProbing(false);
      }
    },
    [setFlow],
  );

  const finishWith = useCallback(
    (project: RegisteredProject, label: string) => {
      void refreshProjects();
      push({
        kind: "success",
        title: label,
        body: project.name,
      });
      closeAddProjectDialog();
      setNavigation({ type: "sessions", sessionName: project.name });
    },
    [push],
  );

  const onSubmit = useCallback(async () => {
    if (!inspect || !inspect.hasIdeYml) return;
    // Already-registered → just open it; don't re-POST. The submit
    // state already has kind:"open" in this case so the button label
    // says "Open project" — wire it to the navigation flow.
    const alreadyRegistered = projects.some((p) => p.name === inspect.name);
    if (alreadyRegistered) {
      const existing = projects.find((p) => p.name === inspect.name);
      if (existing) finishWith(existing, "Project opened");
      return;
    }
    setSubmitting(true);
    try {
      const project = await registerProject(inspect.dir, inspect.name);
      finishWith(project, "Project added");
    } catch (error) {
      push({
        kind: "error",
        title: "Failed to add project",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [finishWith, inspect, projects, push]);

  const onOnboardSubmit = useCallback(
    async (input: OnboardProjectInput) => {
      setSubmitting(true);
      try {
        const project = await onboardProject(input);
        finishWith(project, "Project initialized");
      } catch (error) {
        push({
          kind: "error",
          title: "Failed to onboard project",
          body: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setSubmitting(false);
      }
    },
    [finishWith, push],
  );

  const probedRegistered: RegisteredProject | null = inspect
    ? {
        name: inspect.name,
        dir: inspect.dir,
        hasIdeYml: inspect.hasIdeYml,
        gitOrigin: inspect.gitOrigin,
        gitBranch: inspect.gitBranch,
        registeredAt: "",
      }
    : null;

  const submitState = deriveOpenTabSubmit({
    dir,
    probed: probedRegistered,
    probing,
    existing: projects,
  });

  // ----- pick panel -----
  if (flow.step === "pick") {
    return (
      <div data-testid="add-project-panel-pick" className="flex min-h-0 flex-1 flex-col gap-3">
        <DirectoryBrowserSlot
          value={rawDir}
          onChange={(next) => setRawDir(next)}
          onSelect={(next) => {
            setRawDir(next);
            void probeAt(next);
          }}
          baseDir={baseDir || undefined}
          disabled={probing}
        />

        {!dirValidation.valid && dirValidation.reason && (
          <Banner tone="warn">{dirValidation.reason}</Banner>
        )}

        {probing && <Banner tone="info">Inspecting…</Banner>}

        {probeError && (
          <Banner tone="error" testId="add-project-probe-error">
            {probeError}
          </Banner>
        )}

        <PickFooter />
      </div>
    );
  }

  // ----- confirm panel (has ide.yml) -----
  if (flow.step === "confirm" && inspect && probedRegistered) {
    return (
      <div data-testid="add-project-panel-confirm" className="flex min-h-0 flex-1 flex-col gap-3">
        <ProjectPreview project={probedRegistered} />
        <ConfirmFooter
          onBack={() => setFlow(gotoPick)}
          onSubmit={onSubmit}
          submitting={submitting}
          disabled={!submitState.canSubmit || submitting}
          reason={submitState.reason}
          kind={submitState.kind}
        />
      </div>
    );
  }

  // ----- onboard panel (no ide.yml) -----
  if (flow.step === "onboard" && inspect) {
    return (
      <div data-testid="add-project-panel-onboard" className="flex min-h-0 flex-1 flex-col">
        <OnboardingWizard
          inspect={inspect}
          existingProjects={projects}
          submitting={submitting}
          onCancel={() => setFlow(gotoPick)}
          onSubmit={onOnboardSubmit}
          embedded
        />
      </div>
    );
  }

  return null;
}

// ---------- Initialize ----------

function InitializeTab({ flow, setFlow }: TabPanelProps) {
  const settings = useSettings();
  const { projects } = useProjects();
  const { push } = useToasts();
  const baseDir = settings.general.addProjectBaseDirectory ?? "";

  const initialDir = flow.selectedDir ?? baseDir;
  const [rawDir, setRawDir] = useState(initialDir);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [template, setTemplate] = useState<string>("");
  const [job, dispatch] = useReducer(initJobReducer, { kind: "idle" } as InitJobState);
  const [starting, setStarting] = useState(false);
  const consoleRef = useRef<HTMLPreElement | null>(null);

  const dir = normalizeDir(rawDir, baseDir);
  const dirValidation = validateDir(rawDir || "/");

  const derivedName = useMemo(() => deriveNameFromDir(dir), [dir]);
  const nameValidation = useMemo(
    () => validateName(derivedName, projects),
    [derivedName, projects],
  );

  // Load templates once.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await fetchProjectTemplates();
        if (!active) return;
        setTemplates(data);
      } finally {
        if (active) setTemplatesLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Subscribe to WS frames while a job is running so we can pipe
  // init.output into the reducer and detect init.error.
  useEffect(() => {
    if (job.kind !== "running") return;
    const expectedJobId = job.jobId;
    const release = subscribeGlobal((frame: ServerFrame) => {
      const chunk = parseInitOutputFrame(frame, expectedJobId);
      if (chunk) {
        dispatch({ type: "chunk", jobId: expectedJobId, chunk });
      }
      if (isInitDoneFrame(frame, expectedJobId)) {
        void refreshProjects().then(() => {
          dispatch({ type: "succeeded", jobId: expectedJobId, project: null });
        });
      }
      const errorFrame = isInitErrorFrame(frame, expectedJobId);
      if (errorFrame) {
        dispatch({ type: "failed", jobId: expectedJobId, message: errorFrame.message });
      }
    });
    return () => release();
  }, [job]);

  // Auto-scroll the console.
  useEffect(() => {
    const node = consoleRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [job]);

  const onSubmit = useCallback(async () => {
    if (!dirValidation.valid) return;
    setStarting(true);
    try {
      const { jobId } = await initProject(dir, template || undefined);
      dispatch({ type: "start", jobId });
    } catch (error) {
      push({
        kind: "error",
        title: "Failed to start init",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setStarting(false);
    }
  }, [dir, dirValidation.valid, push, template]);

  const submitState = deriveInitTabSubmit({ dir, template: template || null, job });

  const consoleText = chunksToConsoleText(
    job.kind === "running" || job.kind === "succeeded" || job.kind === "failed" ? job.chunks : [],
  );

  // ----- pick panel -----
  if (flow.step === "pick") {
    return (
      <div
        data-testid="add-project-panel-init-pick"
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <DirectoryBrowserSlot
          value={rawDir}
          onChange={setRawDir}
          onSelect={(next) => {
            setRawDir(next);
            setFlow((s) => commitDir(s, next));
          }}
          baseDir={baseDir || undefined}
        />

        {!dirValidation.valid && dirValidation.reason && (
          <Banner tone="warn">{dirValidation.reason}</Banner>
        )}

        <PickFooter />
      </div>
    );
  }

  // ----- init panel (template + console) -----
  return (
    <div
      data-testid="add-project-panel-init"
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <label className="block">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">Template</span>
        <select
          data-testid="add-project-template-select"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          disabled={templatesLoading || job.kind === "running" || job.kind === "succeeded"}
          className="mt-1 w-full rounded-md border border-[var(--border-weak)] bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--fg)] outline-none focus-visible:focus-ring disabled:opacity-50"
        >
          <option value="">{templatesLoading ? "Loading…" : "Auto-detect"}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {template && (
          <span className="mt-1 block text-[11px] text-[var(--dim)]">
            {templates.find((t) => t.id === template)?.description ?? ""}
          </span>
        )}
      </label>

      {derivedName && !nameValidation.valid && <Banner tone="warn">{nameValidation.reason}</Banner>}

      {(job.kind === "running" || job.kind === "succeeded" || job.kind === "failed") && (
        <pre
          ref={consoleRef}
          data-testid="add-project-output"
          className="max-h-[220px] overflow-auto rounded-md border border-[var(--border-weak)] bg-[var(--bg)] p-3 font-mono text-[11px] leading-5 text-[var(--fg)]"
        >
          {consoleText || "Starting…\n"}
        </pre>
      )}

      {job.kind === "succeeded" && <SuccessPanel jobId={job.jobId} />}

      {job.kind === "failed" && <Banner tone="error">{job.message}</Banner>}

      <InitFooter
        onBack={() => setFlow(gotoPick)}
        onSubmit={onSubmit}
        submitting={starting || job.kind === "running"}
        disabled={!submitState.canSubmit || starting}
        reason={submitState.reason}
        succeeded={job.kind === "succeeded"}
      />
    </div>
  );
}

// ---------- Clone (coming soon) ----------

// TODO: Wire to server-side `/api/projects/clone` once Agent 1 ships it.
function CloneTab() {
  return (
    <div data-testid="add-project-panel-clone" className="flex min-h-0 flex-1 flex-col gap-3">
      <Banner tone="info">
        Cloning straight from Git is coming soon. For now, clone the repo manually and use the{" "}
        <strong>Open existing</strong> tab.
      </Banner>
      <label className="block">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">Git URL</span>
        <input
          disabled
          placeholder="git@github.com:owner/repo.git"
          className="mt-1 w-full rounded-md border border-[var(--border-weak)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--fg)] outline-none disabled:opacity-50"
        />
      </label>
      <CloneFooter />
    </div>
  );
}

// ---------- Footers ----------
//
// Each step renders its own footer inside the dialog's outer DialogFooter
// region. We render a small fixed-position container at the bottom of the
// dialog body so the footer is always visible: panels themselves lay out
// `flex-1` of body content, then a non-flex footer row stays pinned at the
// bottom. (We intentionally don't portal into DialogFooter because the
// markup keeps better testability when it's all in the local subtree.)

function PickFooter() {
  return (
    <FooterRow testId="add-project-footer-pick">
      <Button
        variant="ghost"
        onClick={closeAddProjectDialog}
        data-testid="add-project-cancel"
      >
        Cancel
      </Button>
    </FooterRow>
  );
}

interface ConfirmFooterProps {
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  disabled: boolean;
  reason: string | null;
  /** "add" → button reads "Add project"; "open" → "Open project" (already registered). */
  kind: "add" | "open" | "blocked";
}

function ConfirmFooter({
  onBack,
  onSubmit,
  submitting,
  disabled,
  reason,
  kind,
}: ConfirmFooterProps) {
  const label = kind === "open" ? "Open project" : "Add project";
  return (
    <FooterRow testId="add-project-footer-confirm">
      <Button variant="ghost" onClick={onBack} data-testid="add-project-back">
        Back
      </Button>
      <Button variant="ghost" onClick={closeAddProjectDialog} data-testid="add-project-cancel">
        Cancel
      </Button>
      <Button
        data-testid="add-project-submit"
        data-action={kind}
        onClick={onSubmit}
        isPending={submitting}
        disabled={disabled}
        title={reason ?? undefined}
      >
        {label}
      </Button>
    </FooterRow>
  );
}

interface InitFooterProps {
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  disabled: boolean;
  reason: string | null;
  succeeded: boolean;
}

function InitFooter({
  onBack,
  onSubmit,
  submitting,
  disabled,
  reason,
  succeeded,
}: InitFooterProps) {
  return (
    <FooterRow testId="add-project-footer-init">
      {!succeeded && (
        <Button variant="ghost" onClick={onBack} data-testid="add-project-back">
          Back
        </Button>
      )}
      <Button
        variant="ghost"
        onClick={closeAddProjectDialog}
        data-testid="add-project-cancel"
      >
        {succeeded ? "Close" : "Cancel"}
      </Button>
      {!succeeded && (
        <Button
          data-testid="add-project-submit"
          onClick={onSubmit}
          isPending={submitting}
          disabled={disabled}
          title={reason ?? undefined}
        >
          Initialize
        </Button>
      )}
    </FooterRow>
  );
}

function CloneFooter() {
  return (
    <FooterRow testId="add-project-footer-clone">
      <Button variant="ghost" onClick={closeAddProjectDialog} data-testid="add-project-cancel">
        Cancel
      </Button>
      <Button data-testid="add-project-submit" disabled>
        Clone
      </Button>
    </FooterRow>
  );
}

interface FooterRowProps {
  testId: string;
  children: React.ReactNode;
}

/**
 * Sticky footer pinned to the bottom of the panel's body — guarantees the
 * action buttons stay visible even when panel content overflows. The
 * outer DialogFooter is reserved for the wizard's internal footer.
 */
function FooterRow({ testId, children }: FooterRowProps) {
  return (
    <div
      data-testid={testId}
      className="sticky bottom-0 -mx-4 mt-auto flex justify-end gap-2 border-t border-[var(--border-weak)] bg-[var(--bg-strong)] px-4 py-3"
    >
      {children}
    </div>
  );
}

// ---------- Directory browser slot ----------

interface DirectoryBrowserSlotProps {
  value: string;
  onChange: (path: string) => void;
  onSelect: (path: string) => void;
  baseDir?: string;
  disabled?: boolean;
}

/**
 * Wraps the DirectoryBrowser in a flex-1 container so its entry list has
 * the entire remaining body height to scroll inside.
 */
function DirectoryBrowserSlot(props: DirectoryBrowserSlotProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DirectoryBrowser {...props} />
    </div>
  );
}

// ---------- Shared bits ----------

interface BannerProps {
  tone: "info" | "warn" | "error";
  testId?: string;
  children: React.ReactNode;
}

function Banner({ tone, testId, children }: BannerProps) {
  const color =
    tone === "error"
      ? "border-[var(--red)] text-[var(--red)]"
      : tone === "warn"
        ? "border-[var(--yellow)] text-[var(--yellow)]"
        : "border-[var(--border-weak)] text-[var(--fg)]";
  return (
    <div
      data-testid={testId}
      className={`rounded-md border bg-[var(--surface)] px-3 py-2 text-[11px] leading-5 ${color}`}
    >
      {children}
    </div>
  );
}

function ProjectPreview({ project }: { project: RegisteredProject }) {
  return (
    <div
      data-testid="add-project-preview"
      className="rounded-md border border-[var(--border-weak)] bg-[var(--surface)] px-3 py-2 text-[11px] text-[var(--fg)]"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 aria-hidden="true" size={14} className="text-[var(--green)]" />
        <span className="font-medium">{project.name}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[80px_1fr] gap-y-1 text-[var(--dim)]">
        <dt>Path</dt>
        <dd className="truncate font-mono text-[var(--fg)]">{project.dir}</dd>
        {project.gitOrigin && (
          <>
            <dt>Origin</dt>
            <dd className="truncate font-mono text-[var(--fg)]">{project.gitOrigin}</dd>
          </>
        )}
        {project.gitBranch && (
          <>
            <dt>Branch</dt>
            <dd className="truncate font-mono text-[var(--fg)]">{project.gitBranch}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function SuccessPanel({ jobId }: { jobId: string }) {
  return (
    <div
      data-testid="add-project-success"
      className="rounded-md border border-[var(--green)] bg-[var(--surface)] px-3 py-2 text-[11px] text-[var(--green)]"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 aria-hidden="true" size={14} />
        <span>Project added! (job {jobId})</span>
      </div>
    </div>
  );
}
