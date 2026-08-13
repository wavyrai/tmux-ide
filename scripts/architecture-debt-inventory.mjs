import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const GROUPS = {
  "grouped-pty": {
    description: "Grouped-PTY dependency and authority constructor call sites in shipped source",
    patterns: [
      /(?:from\s+["']node-pty["']|import\s*\(\s*["']node-pty["']\s*\)|resolve\(\s*["']node-pty\/package\.json["']\s*\))/u,
      /external\s*:\s*\[[^\]]*["']node-pty["']/u,
      /\bnew\s+(?:NodePtyAdapter|PtyTmuxAttachmentLauncher|TerminalAttachmentAdmissionCoordinator)\s*\(/u,
      /node_modules["'],\s*["']node-pty["']/u,
    ],
  },
  "direct-tmux": {
    description: "Product clients bypassing SessionRuntime for direct tmux authority",
    patterns: [
      /from\s+["']@tmux-ide\/tmux-bridge["']/u,
      /\b(?:spawn|nodeSpawn|execFile|nodeExecFile|execFileSync)\s*\(\s*["']tmux["']/u,
    ],
  },
  "v1-catalog": {
    description: "V1 application-shell/catalog compatibility surfaces",
    patterns: [
      /\bApplicationShellResourceV1\b/u,
      /\bApplicationShellResourceV1SchemaZ\b/u,
      /\bAPPLICATION_SHELL_RESOURCE_V1_VERSION\b/u,
    ],
  },
  "v1-default-authority": {
    description: "Removed implicit-V1 catalog aliases and default negotiation authority",
    patterns: [/\bAPPLICATION_SHELL_RESOURCE_VERSION\b/u],
  },
  "v1-standalone-authority": {
    description: "Explicit deprecated standalone command-center V1 discovery authority",
    patterns: [
      /(?:export\s+function|resource\s*:)\s*projectDeprecatedStandaloneApplicationShellResourceV1\b/u,
      /export\s+interface\s+DeprecatedStandaloneApplicationShell(?:Pane|Session)Facts\b/u,
    ],
  },
};

export function sourceArchitectureInventory(repoRoot) {
  const files = ["apps", "packages"].flatMap((root) =>
    sourceFiles(resolve(repoRoot, root), repoRoot),
  );
  const groups = Object.fromEntries(
    Object.entries(GROUPS).map(([name, definition]) => {
      const entries = files
        .flatMap((file) =>
          readFileSync(resolve(repoRoot, file), "utf8")
            .split("\n")
            .flatMap((line, index) =>
              definition.patterns.some((pattern) => pattern.test(line))
                ? [{ file, line: index + 1, match: line.trim().slice(0, 240) }]
                : [],
            ),
        )
        .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
      const uses = [...new Set(entries.map((entry) => entry.file))];
      return [
        name,
        {
          description: definition.description,
          remainingUseCount: entries.length,
          remainingFileCount: uses.length,
          zeroUse: entries.length === 0,
          uses,
          entries,
        },
      ];
    }),
  );
  return {
    version: 1,
    groups,
    zeroUseGroups: Object.entries(groups)
      .filter(([, group]) => group.zeroUse)
      .map(([name]) => name),
  };
}

function sourceFiles(directory, repoRoot) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "node_modules", ".turbo"].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(absolute, repoRoot));
    else if (
      [".ts", ".tsx", ".mjs"].includes(extname(entry.name)) &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec.") &&
      !absolute.includes("/__snapshots__/")
    ) {
      result.push(relative(repoRoot, absolute));
    }
  }
  return result;
}
