import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

/**
 * Vitest config for the daemon package. Collection is a glob over every
 * `src/**` test file, minus the files that import `bun:test` — those are
 * listed explicitly in `exclude` below and run under `bun test` instead.
 *
 * The include list used to be enumerated by hand, which silently dropped any
 * test whose path nobody remembered to add (it dropped five). Adding a Vitest
 * test now needs no config change; adding a `bun:test` file does, and it fails
 * loudly at collection rather than disappearing.
 */
export default defineConfig({
  plugins: [solid()],
  // vite-plugin-solid adds the `browser` export condition in test mode so DOM
  // host tests compile with the client Solid runtime. Pin ws to its Node ESM
  // entry so embedded-daemon tests retain WebSocketServer under that condition.
  resolve: {
    alias: [{ find: /^ws$/, replacement: fileURLToPath(import.meta.resolve("ws")) }],
  },
  test: {
    css: true,
    environment: "node",
    // The live suites spawn real daemons/tmux/pty; at unbounded parallelism
    // those spawns starve their budgets. Four workers leaves enough process and
    // PTY headroom for the 20-contender election and live terminal suites even
    // while a developer has the real GUI/TUI stack open beside the test run.
    maxWorkers: 4,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // These import `bun:test` and are run by `bun test` (see the root
    // package.json `test:daemon-bun` / `test:tui-renderer` scripts and the
    // per-package `test` scripts). Vitest cannot resolve `bun:test`.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/command-center/actions/handlers/app-set-remote-access.test.ts",
      "src/command-center/actions/handlers/config-actions.test.ts",
      "src/command-center/actions/handlers/daemon-shutdown.test.ts",
      "src/command-center/actions/handlers/project-activate.test.ts",
      "src/command-center/actions/handlers/project-launch.test.ts",
      "src/command-center/actions/handlers/project-open-terminal.test.ts",
      "src/command-center/actions/handlers/project-restart.test.ts",
      "src/command-center/actions/handlers/project-stop.test.ts",
      "src/command-center/actions/handlers/terminal-respawn.test.ts",
      "src/command-center/actions/handlers/terminal-stop.test.ts",
      "src/command-center/filesystem.test.ts",
      "src/command-center/projects.test.ts",
      "src/command-center/resources/agent-graph-overlay.test.ts",
      "src/command-center/resources/application-shell.test.ts",
      "src/command-center/workspaces.test.ts",
      "src/config-cli.test.ts",
      "src/config.test.ts",
      "src/detect.test.ts",
      "src/init.test.ts",
      "src/inspect.test.ts",
      "src/launch.test.ts",
      "src/lib/active-projects.test.ts",
      "src/lib/app-settings.test.ts",
      "src/lib/auth-token.test.ts",
      "src/lib/auth/auth-service.test.ts",
      "src/lib/auth/middleware.test.ts",
      "src/lib/authorship.test.ts",
      "src/lib/canonical-daemon.test.ts",
      "src/lib/dot-path.test.ts",
      "src/lib/filesystem-browser.test.ts",
      "src/lib/launch-plan.test.ts",
      "src/lib/log.test.ts",
      "src/lib/project-init-runner.test.ts",
      "src/lib/project-inspect.test.ts",
      "src/lib/project-onboard.test.ts",
      "src/lib/project-probe.test.ts",
      "src/lib/project-registry.test.ts",
      "src/lib/session-monitor.test.ts",
      "src/lib/session-options.test.ts",
      "src/lib/shell.test.ts",
      "src/lib/sizes.test.ts",
      "src/lib/slugify.test.ts",
      "src/lib/workspace-registry.test.ts",
      "src/lib/yaml-io.test.ts",
      "src/ls.test.ts",
      "src/postinstall.test.ts",
      "src/send.test.ts",
      "src/server/pty-bridge.test.ts",
      "src/server/ws-route.test.ts",
      "src/stop.test.ts",
      "src/tui/mirror/activity-surface-renderer.test.tsx",
      "src/tui/mirror/changes-terminal-surface-renderer.test.tsx",
      "src/tui/mirror/home-files-surface-renderer.test.tsx",
      "src/tui/mirror/missions-surface-renderer.test.tsx",
      "src/tui/mirror/pane-surface-renderer.test.tsx",
      "src/tui/mirror/recipes-gallery-renderer.test.tsx",
      "src/tui/mirror/shell-chrome-renderer.test.tsx",
      "src/tui/mirror/sidebar-renderer.test.tsx",
      "src/tui/mirror/testing/renderer-harness.test.ts",
      "src/tui/mirror/workspace/agent-terminal-canvas-renderer.test.tsx",
      "src/tui/mirror/workspace/application-shell-renderer.test.tsx",
      "src/tui/mirror/workspace/command-palette-surface-renderer.test.tsx",
      "src/tui/mirror/workspace/opentui-insertion-stability-renderer.test.tsx",
      "src/tui/mirror/workspace/pane-frame-renderer.test.tsx",
      "src/tui/mirror/workspace/workbench-dock-dual-host-renderer.test.tsx",
      "src/tui/mirror/workspace/workbench-shell-renderer.test.tsx",
      "src/ui/web/utils/color.test.ts",
      "src/validate.test.ts",
      "src/widgets/explorer/tree-model.test.ts",
      "src/widgets/lib/files.test.ts",
      "src/widgets/lib/git.test.ts",
      "src/widgets/lib/pane-comms.test.ts",
      "src/widgets/setup/setup-model.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/terminal/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__tests__/**", "**/__mocks__/**", "**/types.ts", "**/index.ts"],
      thresholds: {
        lines: 40,
        functions: 35,
        statements: 40,
        branches: 30,
      },
    },
  },
});
