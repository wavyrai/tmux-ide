/**
 * Config-free project readiness.
 *
 * The classifier in this module is deliberately pure. Filesystem, PATH,
 * authentication, and command checks belong to an adapter which supplies a
 * `ProjectReadinessProbe`. This keeps onboarding deterministic and lets every
 * app surface consume the same result without making `workspace.yml` (or the
 * legacy `ide.yml`) a prerequisite.
 */

export type Availability = "available" | "missing" | "unknown";
export type CommandReadiness = "ready" | "invalid" | "unknown";
export type AuthenticationReadiness = "ready" | "required" | "not-required" | "unknown";
export type ProjectRegistrationState = "unregistered" | "current" | "stale";
export type ProjectPathKind = "directory" | "other" | "missing" | "unknown";
export type HarnessKind = "codex" | "claude" | "opencode" | "shell" | "custom";

export interface ProjectReadinessProjectProbe {
  /** User- or registry-supplied path before canonical project resolution. */
  requestedPath: string;
  /**
   * Canonical project root. Every present directory must resolve a non-empty
   * root before launch; null is valid only while a missing path is repaired.
   */
  root: string | null;
  name: string | null;
  /**
   * Stable identity facts are a pair: key and source must either both be
   * present or both be absent. A present directory requires the complete pair.
   */
  identityKey: string | null;
  identitySource: "git-common-dir" | "canonical-realpath" | null;
  /** Result of inspecting the requested path; omitted by pre-pathKind callers. */
  pathKind?: ProjectPathKind;
  exists: boolean;
  isDirectory: boolean;
  registration: ProjectRegistrationState;
}

export interface ProjectReadinessToolProbe {
  availability: Availability;
  version?: string | null;
}

export interface ProjectReadinessGitProbe extends ProjectReadinessToolProbe {
  /** Null when repository detection could not be completed. */
  repository: boolean | null;
}

export interface ProjectReadinessPlatformProbe {
  os: NodeJS.Platform;
  arch: string;
}

export interface ProjectReadinessHarnessProbe {
  /** Stable profile id. Custom harnesses must not masquerade as built-ins. */
  id: string;
  kind: HarnessKind;
  label: string;
  /** Executable plus argv. An empty vector is always invalid. */
  command: readonly string[];
  installation: Availability;
  commandReadiness: CommandReadiness;
  authentication: AuthenticationReadiness;
  source: "detected" | "workspace" | "user";
  /** Version reported by a read-only probe, when one completed successfully. */
  version?: string | null;
  /** Optional recovery commands supplied by the effectful probe adapter. */
  installCommand?: readonly string[] | null;
  authCommand?: readonly string[] | null;
}

export interface ProjectReadinessProbe {
  project: ProjectReadinessProjectProbe;
  platform: ProjectReadinessPlatformProbe;
  git: ProjectReadinessGitProbe;
  tmux: ProjectReadinessToolProbe;
  shell: ProjectReadinessToolProbe & { command: readonly string[] };
  harnesses: readonly ProjectReadinessHarnessProbe[];
  /** A user choice wins over the deterministic built-in preference order. */
  preferredHarnessId?: string | null;
}

export type ProjectReadinessIssueSeverity = "blocking" | "recoverable";

export type ProjectReadinessIssueCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_PATH_UNVERIFIED"
  | "PROJECT_NOT_DIRECTORY"
  | "PROJECT_REGISTRATION_STALE"
  | "PROJECT_ROOT_UNRESOLVED"
  | "PROJECT_ROOT_INCONSISTENT"
  | "PROJECT_IDENTITY_UNRESOLVED"
  | "PROJECT_IDENTITY_INCONSISTENT"
  | "PLATFORM_UNSUPPORTED"
  | "TMUX_MISSING"
  | "TMUX_UNVERIFIED"
  | "SHELL_MISSING"
  | "SHELL_UNVERIFIED"
  | "SHELL_COMMAND_INVALID"
  | "GIT_MISSING"
  | "GIT_UNVERIFIED"
  | "GIT_REPOSITORY_UNVERIFIED"
  | "NOT_GIT_REPOSITORY"
  | "NO_AGENT_HARNESS"
  | "HARNESS_INSTALL_REQUIRED"
  | "HARNESS_INSTALL_UNVERIFIED"
  | "HARNESS_AUTH_REQUIRED"
  | "HARNESS_AUTH_UNVERIFIED"
  | "HARNESS_COMMAND_INVALID"
  | "HARNESS_COMMAND_UNVERIFIED"
  | "DUPLICATE_HARNESS_ID";

export interface ProjectReadinessIssue {
  id: string;
  code: ProjectReadinessIssueCode;
  severity: ProjectReadinessIssueSeverity;
  message: string;
  harnessId: string | null;
}

export type ProjectRecoveryActionKind =
  | "choose-project"
  | "refresh-project"
  | "relink-project"
  | "remove-stale-project"
  | "view-platform-support"
  | "install-tool"
  | "verify-tool"
  | "initialize-git"
  | "configure-shell"
  | "choose-harness"
  | "install-harness"
  | "authenticate-harness"
  | "edit-harness-command"
  | "verify-harness";

export interface ProjectRecoveryAction {
  id: string;
  issueId: string;
  kind: ProjectRecoveryActionKind;
  label: string;
  target: "project" | "platform" | "git" | "tmux" | "shell" | "harness";
  harnessId: string | null;
  /** Optional argv. Install/auth commands come only from the probe adapter. */
  command: readonly string[] | null;
}

export type HarnessReadinessState =
  | "ready"
  | "install-required"
  | "install-unverified"
  | "auth-required"
  | "auth-unverified"
  | "command-invalid"
  | "command-unverified";

export interface ProjectHarnessReadiness {
  id: string;
  kind: HarnessKind;
  label: string;
  command: readonly string[];
  source: ProjectReadinessHarnessProbe["source"];
  version: string | null;
  state: HarnessReadinessState;
  usable: boolean;
  agentCapable: boolean;
}

export interface ConfigFreeLaunchPane {
  id: string;
  title: string;
  role: "agent" | "shell";
  harnessId: string;
  command: readonly string[];
  focus: boolean;
}

export interface ConfigFreeLaunchPlan {
  source: "config-free-default";
  mode: "agent-workbench" | "terminal-workspace" | "unavailable";
  projectRoot: string | null;
  selectedHarnessId: string | null;
  panes: readonly ConfigFreeLaunchPane[];
  /** Persisting a workspace is an explicit later choice, never a launch gate. */
  configRequired: false;
}

export interface ProjectReadinessResult {
  status: "ready" | "needs-attention" | "blocked";
  canLaunch: boolean;
  project: {
    requestedPath: string;
    root: string | null;
    name: string | null;
    identityKey: string | null;
    identitySource: ProjectReadinessProjectProbe["identitySource"];
    pathKind: ProjectPathKind;
    registration: ProjectRegistrationState;
  };
  capabilities: {
    platform: "supported" | "unsupported";
    git: "ready" | "degraded" | "unverified";
    tmux: "ready" | "missing" | "unverified";
    shell: "ready" | "missing" | "unverified";
    agentHarness: "ready" | "missing" | "unverified";
  };
  harnesses: readonly ProjectHarnessReadiness[];
  issues: readonly ProjectReadinessIssue[];
  blockingIssues: readonly ProjectReadinessIssue[];
  recoverableIssues: readonly ProjectReadinessIssue[];
  recoveryActions: readonly ProjectRecoveryAction[];
  recommendedLaunchPlan: ConfigFreeLaunchPlan;
}

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
const HARNESS_PREFERENCE: Readonly<Record<HarnessKind, number>> = {
  codex: 0,
  claude: 1,
  opencode: 2,
  custom: 3,
  shell: 4,
};

interface MutableClassification {
  issues: ProjectReadinessIssue[];
  actions: ProjectRecoveryAction[];
}

function actionId(issueId: string, suffix: string): string {
  return `${issueId}:${suffix}`;
}

function addIssue(
  state: MutableClassification,
  issue: Omit<ProjectReadinessIssue, "id"> & { id?: string },
  actions: readonly Omit<ProjectRecoveryAction, "id" | "issueId">[] = [],
): ProjectReadinessIssue {
  const id = issue.id ?? `issue:${issue.code.toLowerCase()}:${issue.harnessId ?? "project"}`;
  const complete: ProjectReadinessIssue = { ...issue, id };
  state.issues.push(complete);
  for (const [index, action] of actions.entries()) {
    state.actions.push({
      ...action,
      id: actionId(id, `${action.kind}:${index + 1}`),
      issueId: id,
    });
  }
  return complete;
}

function commandOrNull(command: readonly string[] | null | undefined): readonly string[] | null {
  return command && command.length > 0 ? [...command] : null;
}

function hasValidExecutableToken(command: readonly string[]): boolean {
  const executable = command[0];
  return (
    executable !== undefined &&
    executable.length > 0 &&
    executable === executable.trim() &&
    !executable.includes("\0") &&
    !/[\r\n]/u.test(executable)
  );
}

function classifyHarness(probe: ProjectReadinessHarnessProbe): ProjectHarnessReadiness {
  let state: HarnessReadinessState;
  if (!hasValidExecutableToken(probe.command) || probe.commandReadiness === "invalid") {
    state = "command-invalid";
  } else if (probe.installation === "missing") {
    state = "install-required";
  } else if (probe.installation === "unknown") {
    state = "install-unverified";
  } else if (probe.commandReadiness === "unknown") {
    state = "command-unverified";
  } else if (probe.authentication === "required") {
    state = "auth-required";
  } else if (probe.authentication === "unknown") {
    state = "auth-unverified";
  } else {
    state = "ready";
  }

  return {
    id: probe.id,
    kind: probe.kind,
    label: probe.label,
    command: [...probe.command],
    source: probe.source,
    version: probe.version ?? null,
    state,
    usable: state === "ready",
    agentCapable: probe.kind !== "shell",
  };
}

function harnessIssue(
  state: MutableClassification,
  harness: ProjectHarnessReadiness,
  probe: ProjectReadinessHarnessProbe,
): void {
  const base = {
    severity: "recoverable" as const,
    harnessId: harness.id,
  };
  switch (harness.state) {
    case "ready":
      return;
    case "install-required":
      addIssue(
        state,
        {
          ...base,
          code: "HARNESS_INSTALL_REQUIRED",
          message: `${harness.label} is detected but not installed.`,
        },
        [
          {
            kind: "install-harness",
            label: `Install ${harness.label}`,
            target: "harness",
            harnessId: harness.id,
            command: commandOrNull(probe.installCommand),
          },
        ],
      );
      return;
    case "install-unverified":
      addIssue(
        state,
        {
          ...base,
          code: "HARNESS_INSTALL_UNVERIFIED",
          message: `${harness.label} installation could not be verified.`,
        },
        [
          {
            kind: "verify-harness",
            label: `Verify ${harness.label} installation`,
            target: "harness",
            harnessId: harness.id,
            command: null,
          },
        ],
      );
      return;
    case "auth-required":
      addIssue(
        state,
        {
          ...base,
          code: "HARNESS_AUTH_REQUIRED",
          message: `${harness.label} requires authentication.`,
        },
        [
          {
            kind: "authenticate-harness",
            label: `Sign in to ${harness.label}`,
            target: "harness",
            harnessId: harness.id,
            command: commandOrNull(probe.authCommand),
          },
        ],
      );
      return;
    case "auth-unverified":
      addIssue(
        state,
        {
          ...base,
          code: "HARNESS_AUTH_UNVERIFIED",
          message: `${harness.label} authentication could not be verified.`,
        },
        [
          {
            kind: "verify-harness",
            label: `Verify ${harness.label} authentication`,
            target: "harness",
            harnessId: harness.id,
            command: null,
          },
        ],
      );
      return;
    case "command-invalid":
      addIssue(
        state,
        {
          ...base,
          code: "HARNESS_COMMAND_INVALID",
          message: `${harness.label} has an invalid launch command.`,
        },
        [
          {
            kind: "edit-harness-command",
            label: `Edit ${harness.label} command`,
            target: "harness",
            harnessId: harness.id,
            command: null,
          },
        ],
      );
      return;
    case "command-unverified":
      addIssue(
        state,
        {
          ...base,
          code: "HARNESS_COMMAND_UNVERIFIED",
          message: `${harness.label} launch command could not be verified.`,
        },
        [
          {
            kind: "verify-harness",
            label: `Verify ${harness.label} command`,
            target: "harness",
            harnessId: harness.id,
            command: null,
          },
        ],
      );
  }
}

function selectAgentHarness(
  harnesses: readonly ProjectHarnessReadiness[],
  preferredHarnessId: string | null | undefined,
): ProjectHarnessReadiness | null {
  const ready = harnesses.filter((harness) => harness.agentCapable && harness.usable);
  const preferred = ready.find((harness) => harness.id === preferredHarnessId);
  if (preferred) return preferred;
  return (
    [...ready].sort(
      (left, right) =>
        HARNESS_PREFERENCE[left.kind] - HARNESS_PREFERENCE[right.kind] ||
        left.id.localeCompare(right.id),
    )[0] ?? null
  );
}

function selectShellHarness(
  harnesses: readonly ProjectHarnessReadiness[],
): ProjectHarnessReadiness | null {
  return harnesses.find((harness) => harness.kind === "shell" && harness.usable) ?? null;
}

function createLaunchPlan(
  probe: ProjectReadinessProbe,
  harnesses: readonly ProjectHarnessReadiness[],
  canLaunch: boolean,
): ConfigFreeLaunchPlan {
  if (!canLaunch) {
    return {
      source: "config-free-default",
      mode: "unavailable",
      projectRoot: probe.project.root,
      selectedHarnessId: null,
      panes: [],
      configRequired: false,
    };
  }

  const agent = selectAgentHarness(harnesses, probe.preferredHarnessId);
  const shellHarness = selectShellHarness(harnesses);
  const panes: ConfigFreeLaunchPane[] = [];
  if (agent) {
    panes.push({
      id: "agent-1",
      title: agent.label,
      role: "agent",
      harnessId: agent.id,
      command: [...agent.command],
      focus: true,
    });
  }
  if (shellHarness) {
    panes.push({
      id: "shell",
      title: "Shell",
      role: "shell",
      harnessId: shellHarness.id,
      command: [...shellHarness.command],
      focus: agent === null,
    });
  }

  return {
    source: "config-free-default",
    mode: agent ? "agent-workbench" : "terminal-workspace",
    projectRoot: probe.project.root,
    selectedHarnessId: agent?.id ?? shellHarness?.id ?? null,
    panes,
    configRequired: false,
  };
}

/**
 * Classify normalized project facts into readiness, recovery actions, and a
 * config-free default launch plan. This function performs no I/O.
 */
export function classifyProjectReadiness(probe: ProjectReadinessProbe): ProjectReadinessResult {
  const state: MutableClassification = { issues: [], actions: [] };
  const platformSupported = SUPPORTED_PLATFORMS.has(probe.platform.os);
  const projectPathKind: ProjectPathKind =
    probe.project.pathKind ??
    (probe.project.exists ? (probe.project.isDirectory ? "directory" : "other") : "missing");
  const projectDirectoryPresent =
    projectPathKind === "directory" && probe.project.exists && probe.project.isDirectory;
  const hasProjectRoot = probe.project.root !== null && probe.project.root.trim().length > 0;
  const hasIdentityKey =
    probe.project.identityKey !== null && probe.project.identityKey.trim().length > 0;
  const hasIdentitySource = probe.project.identitySource !== null;

  if (projectPathKind === "unknown") {
    addIssue(
      state,
      {
        code: "PROJECT_PATH_UNVERIFIED",
        severity: "blocking",
        message: `Project path could not be inspected: ${probe.project.requestedPath}`,
        harnessId: null,
      },
      [
        {
          kind: "refresh-project",
          label: "Check project path again",
          target: "project",
          harnessId: null,
          command: null,
        },
        {
          kind: "choose-project",
          label: "Choose another project",
          target: "project",
          harnessId: null,
          command: null,
        },
      ],
    );
  } else if (projectPathKind === "missing") {
    if (probe.project.registration === "stale") {
      addIssue(
        state,
        {
          code: "PROJECT_REGISTRATION_STALE",
          severity: "blocking",
          message: `The registered project path no longer exists: ${probe.project.requestedPath}`,
          harnessId: null,
        },
        [
          {
            kind: "relink-project",
            label: "Locate moved project",
            target: "project",
            harnessId: null,
            command: null,
          },
          {
            kind: "remove-stale-project",
            label: "Remove stale project",
            target: "project",
            harnessId: null,
            command: null,
          },
        ],
      );
    } else {
      addIssue(
        state,
        {
          code: "PROJECT_NOT_FOUND",
          severity: "blocking",
          message: `Project path does not exist: ${probe.project.requestedPath}`,
          harnessId: null,
        },
        [
          {
            kind: "choose-project",
            label: "Choose another project",
            target: "project",
            harnessId: null,
            command: null,
          },
        ],
      );
    }
  } else if (projectPathKind === "other") {
    addIssue(
      state,
      {
        code: "PROJECT_NOT_DIRECTORY",
        severity: "blocking",
        message: `Project path is not a directory: ${probe.project.requestedPath}`,
        harnessId: null,
      },
      [
        {
          kind: "choose-project",
          label: "Choose a project directory",
          target: "project",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  if (projectDirectoryPresent && !hasProjectRoot) {
    addIssue(
      state,
      {
        code: "PROJECT_ROOT_UNRESOLVED",
        severity: "blocking",
        message: `Project root could not be resolved for ${probe.project.requestedPath}.`,
        harnessId: null,
      },
      [
        {
          kind: "refresh-project",
          label: "Resolve project root again",
          target: "project",
          harnessId: null,
          command: null,
        },
        {
          kind: "choose-project",
          label: "Choose another project",
          target: "project",
          harnessId: null,
          command: null,
        },
      ],
    );
  } else if (!projectDirectoryPresent && hasProjectRoot) {
    addIssue(
      state,
      {
        code: "PROJECT_ROOT_INCONSISTENT",
        severity: "blocking",
        message: "A canonical project root was supplied for a path that is not a directory.",
        harnessId: null,
      },
      [
        {
          kind: "refresh-project",
          label: "Refresh project facts",
          target: "project",
          harnessId: null,
          command: null,
        },
        {
          kind: "choose-project",
          label: "Choose a project directory",
          target: "project",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  if (hasIdentityKey !== hasIdentitySource) {
    addIssue(
      state,
      {
        code: "PROJECT_IDENTITY_INCONSISTENT",
        severity: "blocking",
        message: "Project identity key and source must be resolved together.",
        harnessId: null,
      },
      [
        {
          kind: "refresh-project",
          label: "Rebuild project identity",
          target: "project",
          harnessId: null,
          command: null,
        },
      ],
    );
  } else if (projectDirectoryPresent && !hasIdentityKey) {
    addIssue(
      state,
      {
        code: "PROJECT_IDENTITY_UNRESOLVED",
        severity: "blocking",
        message: `Project identity could not be resolved for ${probe.project.requestedPath}.`,
        harnessId: null,
      },
      [
        {
          kind: "refresh-project",
          label: "Resolve project identity again",
          target: "project",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  if (!platformSupported) {
    addIssue(
      state,
      {
        code: "PLATFORM_UNSUPPORTED",
        severity: "blocking",
        message: `tmux-ide does not currently support ${probe.platform.os}/${probe.platform.arch}.`,
        harnessId: null,
      },
      [
        {
          kind: "view-platform-support",
          label: "View supported platforms",
          target: "platform",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  if (probe.tmux.availability === "missing") {
    addIssue(
      state,
      {
        code: "TMUX_MISSING",
        severity: "blocking",
        message: "tmux is required to launch terminal workspaces.",
        harnessId: null,
      },
      [
        {
          kind: "install-tool",
          label: "Install tmux",
          target: "tmux",
          harnessId: null,
          command: null,
        },
      ],
    );
  } else if (probe.tmux.availability === "unknown") {
    addIssue(
      state,
      {
        code: "TMUX_UNVERIFIED",
        severity: "blocking",
        message: "tmux availability could not be verified.",
        harnessId: null,
      },
      [
        {
          kind: "verify-tool",
          label: "Check tmux again",
          target: "tmux",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  const shellCommandInvalid = !hasValidExecutableToken(probe.shell.command);
  if (shellCommandInvalid) {
    addIssue(
      state,
      {
        code: "SHELL_COMMAND_INVALID",
        severity: "blocking",
        message: "No shell command is configured.",
        harnessId: "shell",
      },
      [
        {
          kind: "configure-shell",
          label: "Choose a shell",
          target: "shell",
          harnessId: "shell",
          command: null,
        },
      ],
    );
  } else if (probe.shell.availability === "missing") {
    addIssue(
      state,
      {
        code: "SHELL_MISSING",
        severity: "blocking",
        message: `Shell executable is not available: ${probe.shell.command[0]}`,
        harnessId: "shell",
      },
      [
        {
          kind: "configure-shell",
          label: "Choose an available shell",
          target: "shell",
          harnessId: "shell",
          command: null,
        },
      ],
    );
  } else if (probe.shell.availability === "unknown") {
    addIssue(
      state,
      {
        code: "SHELL_UNVERIFIED",
        severity: "blocking",
        message: "Shell availability could not be verified.",
        harnessId: "shell",
      },
      [
        {
          kind: "verify-tool",
          label: "Check shell again",
          target: "shell",
          harnessId: "shell",
          command: null,
        },
      ],
    );
  }

  if (probe.git.availability === "missing") {
    addIssue(
      state,
      {
        code: "GIT_MISSING",
        severity: "recoverable",
        message: "Git is unavailable; history, diffs, and worktree isolation will be limited.",
        harnessId: null,
      },
      [
        {
          kind: "install-tool",
          label: "Install Git",
          target: "git",
          harnessId: null,
          command: null,
        },
      ],
    );
  } else if (probe.git.availability === "unknown") {
    addIssue(
      state,
      {
        code: "GIT_UNVERIFIED",
        severity: "recoverable",
        message: "Git availability could not be verified.",
        harnessId: null,
      },
      [
        {
          kind: "verify-tool",
          label: "Check Git again",
          target: "git",
          harnessId: null,
          command: null,
        },
      ],
    );
  } else if (probe.git.repository === false) {
    addIssue(
      state,
      {
        code: "NOT_GIT_REPOSITORY",
        severity: "recoverable",
        message: "This directory is not a Git repository; tmux-ide can still launch it.",
        harnessId: null,
      },
      [
        {
          kind: "initialize-git",
          label: "Initialize Git repository",
          target: "git",
          harnessId: null,
          command: ["git", "init"],
        },
      ],
    );
  } else if (probe.git.repository === null) {
    addIssue(
      state,
      {
        code: "GIT_REPOSITORY_UNVERIFIED",
        severity: "recoverable",
        message: "Git repository status could not be verified.",
        harnessId: null,
      },
      [
        {
          kind: "verify-tool",
          label: "Check repository again",
          target: "git",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  const rawHarnesses: ProjectReadinessHarnessProbe[] = [
    {
      id: "shell",
      kind: "shell",
      label: "Shell",
      command: [...probe.shell.command],
      installation: probe.shell.availability,
      commandReadiness: shellCommandInvalid ? "invalid" : "ready",
      authentication: "not-required",
      source: "detected",
    },
    ...probe.harnesses,
  ];
  const harnessIdOccurrences = new Map<string, number>();
  const uniqueHarnessProbes: ProjectReadinessHarnessProbe[] = [];
  for (const harness of rawHarnesses) {
    const occurrence = (harnessIdOccurrences.get(harness.id) ?? 0) + 1;
    harnessIdOccurrences.set(harness.id, occurrence);
    if (occurrence > 1) {
      addIssue(
        state,
        {
          id: `issue:duplicate_harness_id:${harness.id}:${occurrence}`,
          code: "DUPLICATE_HARNESS_ID",
          severity: "recoverable",
          message: `Duplicate harness id ignored: ${harness.id} (occurrence ${occurrence}).`,
          harnessId: harness.id,
        },
        [
          {
            kind: "edit-harness-command",
            label: `Rename duplicate ${harness.label} profile`,
            target: "harness",
            harnessId: harness.id,
            command: null,
          },
        ],
      );
      continue;
    }
    uniqueHarnessProbes.push(harness);
  }

  const harnesses = uniqueHarnessProbes.map(classifyHarness);
  for (const [index, harness] of harnesses.entries()) {
    if (harness.kind !== "shell") harnessIssue(state, harness, uniqueHarnessProbes[index]!);
  }

  const agentHarnesses = harnesses.filter((harness) => harness.agentCapable);
  const readyAgentHarnesses = agentHarnesses.filter((harness) => harness.usable);
  if (readyAgentHarnesses.length === 0) {
    addIssue(
      state,
      {
        code: "NO_AGENT_HARNESS",
        severity: "recoverable",
        message:
          agentHarnesses.length === 0
            ? "No agent harness was detected; a shell-only workspace is available."
            : "No detected agent harness is ready; a shell-only workspace is available.",
        harnessId: null,
      },
      [
        {
          kind: "choose-harness",
          label: "Add or choose an agent harness",
          target: "harness",
          harnessId: null,
          command: null,
        },
      ],
    );
  }

  const blockingIssues = state.issues.filter((issue) => issue.severity === "blocking");
  const recoverableIssues = state.issues.filter((issue) => issue.severity === "recoverable");
  const canLaunch = blockingIssues.length === 0;
  const status = !canLaunch
    ? ("blocked" as const)
    : recoverableIssues.length > 0
      ? ("needs-attention" as const)
      : ("ready" as const);
  const readyShell = harnesses.some((harness) => harness.kind === "shell" && harness.usable);
  const anyUnverifiedAgent = agentHarnesses.some((harness) =>
    ["install-unverified", "auth-unverified", "command-unverified"].includes(harness.state),
  );

  return {
    status,
    canLaunch,
    project: {
      requestedPath: probe.project.requestedPath,
      root: probe.project.root,
      name: probe.project.name,
      identityKey: probe.project.identityKey,
      identitySource: probe.project.identitySource,
      pathKind: projectPathKind,
      registration: probe.project.registration,
    },
    capabilities: {
      platform: platformSupported ? "supported" : "unsupported",
      git:
        probe.git.availability === "unknown"
          ? "unverified"
          : probe.git.availability === "missing"
            ? "degraded"
            : probe.git.repository === null
              ? "unverified"
              : probe.git.repository
                ? "ready"
                : "degraded",
      tmux:
        probe.tmux.availability === "available"
          ? "ready"
          : probe.tmux.availability === "missing"
            ? "missing"
            : "unverified",
      shell: readyShell
        ? "ready"
        : probe.shell.availability === "unknown"
          ? "unverified"
          : "missing",
      agentHarness:
        readyAgentHarnesses.length > 0 ? "ready" : anyUnverifiedAgent ? "unverified" : "missing",
    },
    harnesses,
    issues: state.issues,
    blockingIssues,
    recoverableIssues,
    recoveryActions: state.actions,
    recommendedLaunchPlan: createLaunchPlan(probe, harnesses, canLaunch),
  };
}
