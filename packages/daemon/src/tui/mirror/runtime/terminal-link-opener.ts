import { spawn } from "node:child_process";
import { safeTerminalLink } from "./terminal-links.ts";

/** Launch via argv, never a shell. The caller owns user-visible failure feedback. */
export function openTerminalLink(value: string): Promise<void> {
  const url = safeTerminalLink(value);
  if (!url) return Promise.reject(new Error("Only HTTP and HTTPS terminal links can be opened"));
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Could not open terminal link (exit ${code})`)),
    );
  });
}

export function createTerminalLinkOpener(notify: (message: string) => void): (url: string) => void {
  return (url) => {
    void openTerminalLink(url).then(
      () => notify("Opened terminal link"),
      () => notify("Could not open terminal link"),
    );
  };
}
