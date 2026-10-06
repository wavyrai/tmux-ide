import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export const MANAGED_INSTALLER_URL = "https://tmux-ide.com/install.sh";

/** Only the active release of a marked installation may update its prefix. */
export function managedInstallerPrefix(cliPath: string): string | null {
  const match =
    /^(.*)\/share\/tmux-ide\/releases\/(install-[A-Za-z0-9]{6})\/npm\/lib\/node_modules\/tmux-ide\/bin$/.exec(
      cliPath,
    );
  if (!match) return null;
  const prefix = match[1] || "/";
  const root = join(prefix, "share/tmux-ide");
  const release = join(root, "releases", match[2]!);
  try {
    if (realpathSync(join(root, "current")) !== release) return null;
    if (realpathSync(release) !== release) return null;
    if (readFileSync(join(root, "installer-v1"), "utf8") !== "1\n") return null;
    if (readFileSync(join(release, ".installer-release-v1"), "utf8") !== "1\n") return null;
    if (
      !readFileSync(join(prefix, "bin/tmux-ide"), "utf8")
        .split("\n")
        .includes("# tmux-ide universal installer v1")
    )
      return null;
    if (
      JSON.parse(readFileSync(join(dirname(cliPath), "package.json"), "utf8")).name !== "tmux-ide"
    )
      return null;
    return prefix;
  } catch {
    return null;
  }
}

/** Download completely before execution; the canonical installer owns activation and rollback. */
export function runManagedInstallerUpdate(
  prefix: string,
  channel: string,
  json: boolean,
  execute: typeof execFileSync = execFileSync,
): void {
  const temporary = mkdtempSync(join(tmpdir(), "tmux-ide-update-"));
  const script = join(temporary, "install.sh");
  try {
    execute(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "15",
        "--max-time",
        "180",
        "--output",
        script,
        MANAGED_INSTALLER_URL,
      ],
      { stdio: ["ignore", 2, 2] },
    );
    if (!readFileSync(script, "utf8").startsWith("#!/bin/sh\n"))
      throw new Error("Installer download was not a shell script; installation unchanged");
    execute("/bin/sh", ["-n", script], { stdio: ["ignore", 2, 2] });
    execute("/bin/sh", [script, "--prefix", prefix, "--version", channel], {
      stdio: json ? ["ignore", 2, 2] : "inherit",
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
