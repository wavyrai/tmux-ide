import type { HostCapabilities } from "@tmux-ide/contracts";
declare global {
  interface Window {
    tmuxIdeHost?: HostCapabilities;
  }
}
export {};
