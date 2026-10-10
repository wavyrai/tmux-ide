export function devServerProcessIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

export function formatProductRigReady(state) {
  return `Product rig ready: ${state.session} · terminal-only`;
}
export function formatProductRigCapture(result) {
  return `Captured terminal ${result.tuiPath} and tmux ${result.tmuxPath}`;
}
