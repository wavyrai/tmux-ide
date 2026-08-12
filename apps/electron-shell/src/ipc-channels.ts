/**
 * Private, finite IPC vocabulary. Never export a generic renderer channel.
 *
 * `daemonRequest` is one channel, not a generic one: it carries a
 * `DaemonResourceRequest`, a closed union declared in the contracts package and
 * validated on arrival, so the reachable surface is still exactly the resources
 * reviewed there. What collapsed is the plumbing — fifteen constants, fifteen
 * allow-list entries, fifteen preload stubs and fifteen handlers that expressed
 * fifteen ideas.
 */
export const HOST_IPC = {
  bootstrap: "tmux-ide:host/bootstrap",
  windowMinimize: "tmux-ide:host/window/minimize",
  windowToggleMaximized: "tmux-ide:host/window/toggle-maximized",
  windowClose: "tmux-ide:host/window/close",
  windowStateChanged: "tmux-ide:host/window/state-changed",
  workspaceOpenProjectDirectory: "tmux-ide:host/workspace/open-project-directory",
  onboardingAcknowledgeIntro: "tmux-ide:host/onboarding/acknowledge-intro",
  themeChanged: "tmux-ide:host/theme/changed",
  updateGetStatus: "tmux-ide:host/update/get-status",
  updateStatusChanged: "tmux-ide:host/update/status-changed",
  daemonRequest: "tmux-ide:host/daemon/request",
  daemonCancelRequest: "tmux-ide:host/daemon/cancel-request",
  daemonSubscribe: "tmux-ide:host/daemon/subscribe",
  daemonCancelSubscribe: "tmux-ide:host/daemon/cancel-subscribe",
  daemonUnsubscribe: "tmux-ide:host/daemon/unsubscribe",
  daemonEvent: "tmux-ide:host/daemon/event",
} as const;

export const HOST_INVOKE_CHANNELS = [
  HOST_IPC.bootstrap,
  HOST_IPC.windowMinimize,
  HOST_IPC.windowToggleMaximized,
  HOST_IPC.windowClose,
  HOST_IPC.workspaceOpenProjectDirectory,
  HOST_IPC.onboardingAcknowledgeIntro,
  HOST_IPC.updateGetStatus,
  HOST_IPC.daemonRequest,
  HOST_IPC.daemonCancelRequest,
  HOST_IPC.daemonSubscribe,
  HOST_IPC.daemonCancelSubscribe,
  HOST_IPC.daemonUnsubscribe,
] as const;
