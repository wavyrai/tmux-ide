import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { defaultSpawnChild } from "./daemon-supervisor.ts";

/**
 * The daemon child mints its owner/bypass tokens in-process and publishes them
 * only through the owner-only (0600) canonical daemon record. The supervisor
 * therefore must never place credential material on argv or add it to the
 * child environment, where any same-user process could read it.
 */
describe("daemon child spawn secret handoff", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("passes only the child entry on argv and only non-secret configuration in env", () => {
    spawnMock.mockReturnValue({ stub: true });

    defaultSpawnChild("/packaged/daemon-child.cjs", "2.8.0");

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string | undefined>; stdio: unknown },
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["/packaged/daemon-child.cjs"]);
    for (const argument of args) {
      expect(argument.toLowerCase()).not.toMatch(/token|secret|bearer|auth/u);
    }

    // Exactly these keys are set by the supervisor; none carries credential
    // material. Everything else must mirror the parent environment, except
    // the removed code-injection vectors.
    const supervisorKeys = new Set([
      "ELECTRON_RUN_AS_NODE",
      "TMUX_IDE_DESKTOP_PRODUCT_VERSION",
      "TMUX_IDE_TEMPLATES_DIR",
    ]);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(options.env.TMUX_IDE_DESKTOP_PRODUCT_VERSION).toBe("2.8.0");
    expect(options.env.TMUX_IDE_TEMPLATES_DIR).toBe("/packaged/templates");
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.NODE_PATH).toBeUndefined();
    for (const [key, value] of Object.entries(options.env)) {
      if (supervisorKeys.has(key)) {
        expect(`${key}=${value ?? ""}`.toLowerCase()).not.toMatch(/token|secret|bearer/u);
        continue;
      }
      expect(value, `env ${key} must mirror the parent environment`).toBe(process.env[key]);
    }

    // stdin is closed: the contract is "no secret handoff needed", not a
    // secret pipe the child would wait on.
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});
