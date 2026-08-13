const TOKEN = /[A-Za-z0-9_./:@-]{5,}/gu;

export const REQUIRED_TUI_PHASES = Object.freeze([
  "application-shell-inventory-applied",
  "runtime-lane-layout",
  "runtime-lane-connected",
  "first-terminal-frame",
]);

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
  const phase = (name) => timeline.find((entry) => entry?.phase === name) ?? null;
  const inventory = phase("application-shell-inventory-applied");
  const layouts = timeline.filter(
    (entry) => entry?.phase === "runtime-lane-layout" && entry.currentWindow === true,
  );
  const layout = layouts.at(-1) ?? null;
  const connected = phase("runtime-lane-connected");
  const firstTerminalFrame = phase("first-terminal-frame");
  const attachable =
    applicationShell?.resource?.terminalInventory?.resources?.filter(
      (resource) => resource?.attachability?.status === "available",
    ) ?? [];
  const live = catalog?.liveSessions?.find((session) => session?.sessionName === target) ?? null;
  const truthTokens = diagnosticTokens(panes.map((pane) => pane.capture).join("\n"));
  const matchedTokens = truthTokens.filter((token) => frame.includes(token));
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
      id: "runtime-lane",
      passed:
        Number(inventory?.descriptorCount) === panes.length &&
        Number(layout?.paneCount) > 0 &&
        connected?.generation === daemon?.instanceId,
      detail: `${inventory?.descriptorCount ?? 0} descriptors, ${layout?.paneCount ?? 0} current-window panes`,
    },
    {
      id: "terminal-frame",
      passed:
        Number.isFinite(firstTerminalFrame?.elapsedMs) &&
        Number.isFinite(connected?.elapsedMs) &&
        firstTerminalFrame.elapsedMs >= connected.elapsedMs,
      detail: `connected ${connected?.elapsedMs ?? "?"}ms → terminal frame ${firstTerminalFrame?.elapsedMs ?? "?"}ms`,
    },
    {
      id: "framebuffer-content",
      passed:
        frame.includes(target) &&
        frame.includes("Terminals") &&
        (truthTokens.length === 0 || matchedTokens.length > 0),
      detail:
        truthTokens.length === 0
          ? "tmux panes contain no stable text token"
          : `${matchedTokens.length}/${truthTokens.length} tmux text tokens visible`,
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
        REQUIRED_TUI_PHASES.map((name) => {
          const entry = phase(name);
          return Object.freeze({ phase: name, elapsedMs: entry?.elapsedMs ?? null });
        }),
      ),
    }),
  });
}
