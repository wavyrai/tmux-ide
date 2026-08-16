const TOKEN = /[A-Za-z0-9_./:@-]{5,}/gu;

export const REQUIRED_TUI_PHASES = Object.freeze([
  "generation-shell-lifecycle:live",
  "generation-runtime-progress:physical-ready",
  "generation-runtime-progress:coherent",
  "generation-status:live",
  "first-terminal-frame",
]);

export function normalizeTuiLifecycle(timeline) {
  const first = (predicate) => timeline.find(predicate) ?? null;
  const shellLive = first(
    (entry) =>
      entry?.phase === "generation-shell-lifecycle" &&
      entry?.clientPhase === "live" &&
      entry?.shellStatus === "live",
  );
  const physicalReady = first(
    (entry) =>
      entry?.phase === "generation-runtime-progress" && entry?.runtimePhase === "physical-ready",
  );
  const coherent = first(
    (entry) => entry?.phase === "generation-runtime-progress" && entry?.runtimePhase === "coherent",
  );
  const generationLive = first(
    (entry) => entry?.phase === "generation-status" && entry?.status === "live",
  );
  const firstTerminalFrame = first((entry) => entry?.phase === "first-terminal-frame");
  return Object.freeze({ shellLive, physicalReady, coherent, generationLive, firstTerminalFrame });
}

export function diagnosticTokens(value) {
  const tokens = String(value ?? "").match(TOKEN) ?? [];
  return [...new Set(tokens)].filter(
    (token) =>
      !["Terminal", "Terminals", "workspace", "tmux-ide", "palette", "Changes", "Files"].includes(
        token,
      ),
  );
}

export function analyzeTuiDiagnostic({
  target,
  daemon,
  health,
  identity,
  catalog,
  applicationShell,
  panes,
  frame,
  timeline,
}) {
  const lifecycle = normalizeTuiLifecycle(timeline);
  const attachable =
    applicationShell?.resource?.terminalInventory?.resources?.filter(
      (resource) => resource?.attachability?.status === "available",
    ) ?? [];
  const live = catalog?.liveSessions?.find((session) => session?.sessionName === target) ?? null;
  const visiblePanes = panes.filter((pane) => pane.windowActive);
  const visiblePaneEvidence = visiblePanes.map((pane) => {
    const tokens = diagnosticTokens(pane.capture).filter((token) => token !== target);
    return Object.freeze({
      paneId: pane.paneId,
      tokenCount: tokens.length,
      matchedTokens: Object.freeze(tokens.filter((token) => frame.includes(token))),
    });
  });
  const matchedTokens = visiblePaneEvidence.flatMap((pane) => pane.matchedTokens);
  const checks = [
    {
      id: "daemon",
      passed:
        health?.ok === true &&
        identity?.ok === true &&
        typeof daemon?.instanceId === "string" &&
        daemon.instanceId === identity?.instanceId &&
        daemon.pid === identity?.pid &&
        daemon.protocolVersion === identity?.protocolVersion &&
        daemon.instanceId === catalog?.daemon?.instanceId &&
        daemon.instanceId === applicationShell?.daemon?.instanceId,
      detail:
        health?.ok === true && identity?.ok === true
          ? `generation ${daemon?.instanceId ?? "unknown"}`
          : "health or identity probe failed",
    },
    {
      id: "catalog",
      passed: Boolean(live) && Number(live?.paneCount) === panes.length,
      detail: `${live?.paneCount ?? 0} catalog panes / ${panes.length} tmux panes`,
    },
    {
      id: "application-shell",
      passed:
        attachable.length === panes.length &&
        attachable.every((resource) => resource?.attachability?.semanticPaneId),
      detail: `${attachable.length} attachable semantic panes`,
    },
    {
      id: "workspace-client-commit",
      passed:
        lifecycle.shellLive?.inventoryResources === panes.length &&
        lifecycle.shellLive?.inventoryAttachability?.every(
          (resource) => resource?.status === "available" && resource?.semanticPaneId,
        ),
      detail: `${lifecycle.shellLive?.inventoryResources ?? 0} committed inventory resources`,
    },
    {
      id: "terminal-fast-lane",
      passed:
        Number(lifecycle.physicalReady?.panes) === panes.length &&
        Number(lifecycle.coherent?.seededPanes) === panes.length &&
        lifecycle.generationLive?.daemonGeneration === daemon?.instanceId,
      detail: `${lifecycle.physicalReady?.panes ?? 0} physical panes, ${lifecycle.coherent?.seededPanes ?? 0} seeded panes`,
    },
    {
      id: "tui-painted-frame",
      passed:
        Number.isFinite(lifecycle.firstTerminalFrame?.elapsedMs) &&
        Number.isFinite(lifecycle.coherent?.elapsedMs) &&
        lifecycle.firstTerminalFrame.elapsedMs >= lifecycle.coherent.elapsedMs,
      detail: `coherent ${lifecycle.coherent?.elapsedMs ?? "?"}ms → terminal frame ${lifecycle.firstTerminalFrame?.elapsedMs ?? "?"}ms`,
    },
    {
      id: "framebuffer-content",
      passed:
        frame.includes(target) &&
        frame.includes("Terminals") &&
        visiblePaneEvidence.every(
          ({ tokenCount, matchedTokens: matches }) => tokenCount === 0 || matches.length > 0,
        ),
      detail:
        visiblePaneEvidence.length === 0
          ? "no visible tmux pane"
          : `${visiblePaneEvidence.filter(({ matchedTokens: matches }) => matches.length > 0).length}/${visiblePaneEvidence.length} visible pane bodies matched`,
    },
  ];
  const firstFailure = checks.find((check) => !check.passed)?.id ?? null;
  return Object.freeze({
    passed: firstFailure === null,
    firstFailure,
    checks: Object.freeze(checks),
    evidence: Object.freeze({
      tmuxPaneCount: panes.length,
      attachablePaneCount: attachable.length,
      matchedTokens: Object.freeze(matchedTokens.slice(0, 20)),
      lifecycle: Object.freeze(
        [
          ["generation-shell-lifecycle:live", lifecycle.shellLive],
          ["generation-runtime-progress:physical-ready", lifecycle.physicalReady],
          ["generation-runtime-progress:coherent", lifecycle.coherent],
          ["generation-status:live", lifecycle.generationLive],
          ["first-terminal-frame", lifecycle.firstTerminalFrame],
        ].map(([phase, entry]) => Object.freeze({ phase, elapsedMs: entry?.elapsedMs ?? null })),
      ),
      visiblePaneEvidence: Object.freeze(visiblePaneEvidence),
    }),
  });
}
