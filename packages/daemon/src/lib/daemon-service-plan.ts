import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { runtimeNamespaceEnvironment, type RuntimeNamespace } from "./runtime-namespace.ts";

export interface DaemonServicePlan {
  readonly manager: "launchd" | "systemd";
  readonly supervisionId: string;
  readonly target: string;
  readonly unitPath: string;
  readonly recordPath: string;
  readonly executable: string;
  readonly contents: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

function safeValue(value: string, name: string): string {
  if (!value || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new TypeError(`${name} must be nonempty and contain no control characters`);
  return value;
}

function absolute(value: string, name: string): string {
  safeValue(value, name);
  if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return value;
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}

// systemd applies specifier expansion to paths, environment values and ExecStart.
// ExecStart additionally expands dollars unless the ':' executable prefix is used.
function systemd(value: string): string {
  return `"${value.replace(/%/gu, "%%").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/** Pure rendering only. Reservation and OS-manager mutations belong to the lifecycle owner. */
export function planDaemonService(options: {
  platform: string;
  uid: number;
  home: string;
  configHome?: string;
  executable: string;
  path: string;
  namespace: RuntimeNamespace;
}): DaemonServicePlan {
  const { namespace } = options;
  if (options.platform !== "darwin" && options.platform !== "linux")
    throw new TypeError("Daemon services support macOS launchd and Linux systemd user managers");
  if (!Number.isSafeInteger(options.uid) || options.uid <= 0)
    throw new TypeError("Daemon services require a non-root user");
  if (namespace.mode === "development")
    throw new TypeError("Development instances own their lifecycle; use dev:instance instead");
  const home = absolute(options.home, "Home directory");
  const executable = absolute(options.executable, "Stable CLI executable");
  // Keep the supplied stable launcher path. realpath would pin installer services
  // to a retired version instead of following the next verified activation.
  const identity = createHash("sha256")
    .update(absolute(namespace.daemonInfoDir, "Daemon state directory"))
    .digest("hex")
    .slice(0, 24);
  const supervisionId = `tmux-ide.${identity}`;
  const stdoutPath = join(namespace.daemonInfoDir, "service.stdout.log");
  const stderrPath = join(namespace.daemonInfoDir, "service.stderr.log");
  const environment = {
    HOME: home,
    PATH: safeValue(options.path, "Service PATH"),
    ...runtimeNamespaceEnvironment(namespace),
    TMUX_IDE_CONFIG: namespace.configPath,
    TMUX_IDE_SETTINGS_DIR: namespace.settingsDir,
    TMUX_IDE_CLAUDE_DIR: namespace.claudeDir,
    TMUX_IDE_CLAUDE_SETTINGS: namespace.claudeSettingsPath,
    TMUX_IDE_CLAUDE_HOOK_PATH: namespace.claudeHookPath,
    TMUX_IDE_OPENCODE_DIR: namespace.opencodeDir,
  };
  for (const [name, value] of Object.entries(environment)) safeValue(value, name);
  const args = [executable, "--headless", "--supervised", supervisionId];
  const shared = {
    supervisionId,
    executable,
    recordPath: join(namespace.daemonInfoDir, "service.json"),
    stdoutPath,
    stderrPath,
  };
  if (options.platform === "darwin") {
    const label = `com.${supervisionId}`;
    const string = (value: string) => `<string>${xml(value)}</string>`;
    return Object.freeze({
      ...shared,
      manager: "launchd",
      target: `gui/${options.uid}/${label}`,
      unitPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${args.map(string).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
        .map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`)
        .join("")}</dict>
<key>WorkingDirectory</key>${string(home)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>3</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key>${string(stdoutPath)}
<key>StandardErrorPath</key>${string(stderrPath)}
</dict></plist>
`,
    });
  }
  const configHome = absolute(options.configHome ?? join(home, ".config"), "Config directory");
  const target = `${supervisionId}.service`;
  // WorkingDirectory is a raw path, not an ExecStart-style quoted word.
  // The equivalent '/.' suffix preserves trailing spaces/backslashes without
  // allowing the unit parser to trim them or treat them as line continuation.
  const workingDirectory = `${home.replace(/%/gu, "%%")}/.`;
  return Object.freeze({
    ...shared,
    manager: "systemd",
    target,
    unitPath: join(configHome, "systemd", "user", target),
    contents: `[Unit]
Description=tmux-ide canonical user daemon
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=exec
ExecStart=:${args.map(systemd).join(" ")}
WorkingDirectory=${workingDirectory}
${Object.entries(environment)
  .map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`)
  .join("\n")}
Restart=always
RestartSec=3
TimeoutStopSec=30
# tmux pane work has an independent lifetime; never kill the whole service cgroup.
KillMode=process
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`,
  });
}
