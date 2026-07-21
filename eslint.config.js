import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: [
      ".worktrees/**",
      "docs/**",
      "node_modules/**",
      "coverage/**",
      "context/**",
      "dist/**",
      ".next/**",
      "plans/**",
      "templates/**",
      ".github/**",
      // bin/cli.js is a bundled artefact emitted by scripts/build-cli.mjs.
      // Linting it surfaces ~80 dead-symbol false positives from the
      // bundler's variable renamer.
      "bin/cli.js",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "bin/**/*.{js,mjs}",
      "scripts/**/*.{js,mjs}",
      "apps/**/scripts/**/*.{js,mjs}",
      "src/**/*.{js,mjs}",
      "*.{js,mjs}",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        // scripts/build-tui.mjs runs under `bun` and uses the Bun global.
        Bun: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: [
      "bin/**/*.ts",
      "scripts/**/*.ts",
      "src/**/*.ts",
      "packages/contracts/src/**/*.ts",
      "packages/daemon/src/**/*.ts",
      "packages/tmux-bridge/src/**/*.ts",
      "apps/**/*.{ts,tsx}",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  {
    files: ["apps/desktop-renderer/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "electron",
                "electron/*",
                "node:*",
                "@tmux-ide/electron-shell",
                "**/electron-shell/**",
              ],
              message:
                "the desktop renderer is browser-native; desktop access goes through HostCapabilities",
            },
          ],
        },
      ],
    },
  },

  // ===========================================================================
  // Zone boundaries (ARCHITECTURE.md "Import direction").
  //
  //   contracts ← tmux-bridge ← daemon
  //
  // Arrows point in the allowed direction; A ← B means "B may import A".
  // Each block applies `no-restricted-imports` to one zone using ESLint's
  // built-in rule. The disallow list covers both the workspace alias
  // ("@tmux-ide/daemon") AND the raw relative-path glob
  // ("**/packages/daemon/**") so back-edges fail regardless of how the
  // import is written.
  // ===========================================================================
  {
    files: ["packages/contracts/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tmux-ide/*", "!@tmux-ide/contracts"],
              message: "contracts is the leaf zone — no workspace imports allowed",
            },
            {
              group: ["**/packages/*/src/**", "!**/packages/contracts/src/**"],
              message: "contracts is the leaf zone — no relative reaches into other packages",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/tmux-bridge/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tmux-ide/*", "!@tmux-ide/contracts"],
              message: "tmux-bridge may only import @tmux-ide/contracts",
            },
            {
              group: [
                "**/packages/*/src/**",
                "!**/packages/contracts/src/**",
                "!**/packages/tmux-bridge/src/**",
              ],
              message: "tmux-bridge may only relative-import within itself or contracts",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/daemon/src/tui/mirror/workspace/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../app.tsx",
                "**/mirror/app.tsx",
                "../session-mirror.ts",
                "**/mirror/session-mirror.ts",
                "../pane-mirror.ts",
                "**/mirror/pane-mirror.ts",
                "../control-client.ts",
                "**/mirror/control-client.ts",
                "../missions-workspace.ts",
                "**/mirror/missions-workspace.ts",
                "**/command-center/**",
                "**/server/**",
                "**/lib/**",
              ],
              message:
                "the application-workspace layer is presentational; runtime adapters stay in the root controller",
            },
          ],
        },
      ],
    },
  },
];
