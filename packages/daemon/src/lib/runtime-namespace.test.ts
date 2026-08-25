import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRuntimeNamespace, runtimeNamespaceEnvironment } from "./runtime-namespace.ts";

const userHome = "/Users/runtime-test";
const cwd = "/checkout/tmux-ide";

describe("RuntimeNamespace", () => {
  it("classifies an actual Unix socket without realpathing its leaf", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-runtime-socket-"));
    const socketPath = join(root, "t.sock");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      expect(
        resolveRuntimeNamespace({
          env: {
            TMUX_IDE_RUNTIME_MODE: "testdrive",
            TMUX_IDE_HOME: join(root, "state"),
            TMUX_IDE_REGISTRY_DIR: join(root, "registry"),
            TMUX_IDE_DAEMON_INFO_DIR: join(root, "daemon"),
            TMUX_IDE_TMUX_SOCKET_PATH: socketPath,
            TMUX_IDE_CLEANUP_TOKEN: "runtime:socket:test",
          },
          userHome: join(root, "user"),
          cwd,
        }).tmuxSocket,
      ).toEqual({ kind: "path", path: socketPath });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("uses canonical authority only for production", () => {
    expect(resolveRuntimeNamespace({ env: {}, userHome, cwd })).toEqual({
      mode: "production",
      stateHome: join(userHome, ".tmux-ide"),
      registryDir: join(userHome, ".tmux-ide"),
      daemonInfoDir: join(userHome, ".tmux-ide"),
      controlSocketPath: join(userHome, ".tmux-ide", "control.sock"),
      eventLogPath: join(userHome, ".tmux-ide", "events.jsonl"),
      tmuxSocket: { kind: "name", name: "default" },
      cleanupToken: null,
      namespaceId: "canonical",
      persistence: "durable",
      isolated: false,
    });
  });

  it("inherits daemon publication from an explicit registry authority", () => {
    expect(
      resolveRuntimeNamespace({
        env: {
          TMUX_IDE_REGISTRY_DIR: "/tmp/tmux-ide-registry",
          TMUX_IDE_DAEMON_INFO_DIR: "",
        },
        userHome,
        cwd,
      }).daemonInfoDir,
    ).toBe("/tmp/tmux-ide-registry");
  });

  it.each(["test", "smoke", "testdrive", "performance"])(
    "rejects canonical state in %s mode",
    (mode) => {
      expect(() =>
        resolveRuntimeNamespace({
          env: {
            TMUX_IDE_RUNTIME_MODE: mode,
            TMUX_IDE_TMUX_SOCKET_NAME: "isolated",
            TMUX_IDE_CLEANUP_TOKEN: "isolated:cleanup",
          },
          userHome,
          cwd,
        }),
      ).toThrow("requires an explicit TMUX_IDE_HOME");
      expect(() =>
        resolveRuntimeNamespace({
          env: {
            TMUX_IDE_RUNTIME_MODE: mode,
            TMUX_IDE_HOME: join(userHome, ".tmux-ide"),
            TMUX_IDE_TMUX_SOCKET_NAME: "isolated",
            TMUX_IDE_CLEANUP_TOKEN: "isolated:cleanup",
          },
          userHome,
          cwd,
        }),
      ).toThrow("cannot use the canonical tmux-ide state home");
    },
  );

  it("requires cleanup ownership for isolated runtimes", () => {
    expect(() =>
      resolveRuntimeNamespace({
        env: {
          TMUX_IDE_RUNTIME_MODE: "test",
          TMUX_IDE_HOME: "/tmp/isolated",
          TMUX_IDE_TMUX_SOCKET_NAME: "isolated",
        },
        userHome,
        cwd,
      }),
    ).toThrow("requires an explicit TMUX_IDE_CLEANUP_TOKEN");
  });

  it("rejects canonical registry and daemon overrides from an isolated home", () => {
    for (const key of ["TMUX_IDE_REGISTRY_DIR", "TMUX_IDE_DAEMON_INFO_DIR"]) {
      expect(() =>
        resolveRuntimeNamespace({
          env: {
            TMUX_IDE_RUNTIME_MODE: "test",
            TMUX_IDE_HOME: "/tmp/isolated",
            TMUX_IDE_TMUX_SOCKET_NAME: "isolated",
            TMUX_IDE_CLEANUP_TOKEN: "isolated:cleanup",
            [key]: join(userHome, ".tmux-ide"),
          },
          userHome,
          cwd,
        }),
      ).toThrow("cannot use canonical registry or daemon state");
    }
  });

  it("rejects isolated state and socket paths nested under canonical state", () => {
    const canonicalHome = join(userHome, ".tmux-ide");
    expect(() =>
      resolveRuntimeNamespace({
        env: {
          TMUX_IDE_RUNTIME_MODE: "performance",
          TMUX_IDE_HOME: join(canonicalHome, "bench"),
          TMUX_IDE_TMUX_SOCKET_NAME: "bench",
          TMUX_IDE_CLEANUP_TOKEN: "benchmark:cleanup",
        },
        userHome,
        cwd,
      }),
    ).toThrow("cannot use the canonical tmux-ide state home");

    expect(() =>
      resolveRuntimeNamespace({
        env: {
          TMUX_IDE_RUNTIME_MODE: "performance",
          TMUX_IDE_HOME: "/tmp/isolated",
          TMUX_IDE_TMUX_SOCKET_PATH: join(canonicalHome, "bench.sock"),
          TMUX_IDE_CLEANUP_TOKEN: "benchmark:cleanup",
        },
        userHome,
        cwd,
      }),
    ).toThrow("cannot use a tmux socket inside canonical state");
  });

  it.each(["test", "smoke", "testdrive", "performance"])(
    "rejects the default tmux socket in %s mode",
    (mode) => {
      expect(() =>
        resolveRuntimeNamespace({
          env: {
            TMUX_IDE_RUNTIME_MODE: mode,
            TMUX_IDE_HOME: "/tmp/isolated",
            TMUX_IDE_CLEANUP_TOKEN: "isolated:cleanup",
          },
          userHome,
          cwd,
        }),
      ).toThrow("requires a non-default TMUX_IDE_TMUX_SOCKET_NAME");
    },
  );

  it("exports one coherent environment bundle", () => {
    const namespace = resolveRuntimeNamespace({
      env: {
        TMUX_IDE_RUNTIME_MODE: "performance",
        TMUX_IDE_HOME: ".tasks/reference/home",
        TMUX_IDE_REGISTRY_DIR: ".tasks/reference/registry",
        TMUX_IDE_DAEMON_INFO_DIR: ".tasks/reference/daemon",
        TMUX_IDE_TMUX_SOCKET_NAME: "reference-42",
        TMUX_IDE_CLEANUP_TOKEN: "reference:cleanup:42",
      },
      userHome,
      cwd,
    });
    expect(runtimeNamespaceEnvironment(namespace)).toEqual({
      TMUX_IDE_RUNTIME_MODE: "performance",
      TMUX_IDE_HOME: "/checkout/tmux-ide/.tasks/reference/home",
      TMUX_IDE_REGISTRY_DIR: "/checkout/tmux-ide/.tasks/reference/registry",
      TMUX_IDE_DAEMON_INFO_DIR: "/checkout/tmux-ide/.tasks/reference/daemon",
      TMUX_IDE_TMUX_SOCKET_NAME: "reference-42",
      TMUX_IDE_CLEANUP_TOKEN: "reference:cleanup:42",
    });
  });
});
