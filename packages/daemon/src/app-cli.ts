import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export function appCommand(): void {
  const candidates = ["/Applications/tmux-ide.app", `${homedir()}/Applications/tmux-ide.app`];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      execFileSync("open", ["-a", candidate], { stdio: "ignore" });
      return;
    }
  }

  console.log("tmux-ide.app not found.");
  console.log("Download from https://github.com/wavyrai/tmux-ide/releases");
  process.exit(1);
}
