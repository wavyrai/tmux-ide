import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";
import { discoverLiveSessionSummaries } from "../../command-center/discovery.ts";
import { FleetLifecycleAuthority } from "../fleet-lifecycle-authority.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux)("native fleet creation incarnation receipt", () => {
  it("returns the catalog incarnation only when requested and preserves legacy receipt shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "zz-tmux-ide-create-identity-"));
    const socket = join(root, "tmux.sock");
    const executable = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
    const env = { ...process.env, TMUX: "", HOME: root, SHELL: "/bin/sh" };
    const run = (args: readonly string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const workspaces: Workspace[] = [];
    const generation = randomUUID();
    const authority = new FleetLifecycleAuthority({
      daemonInstanceId: generation,
      productVersion: "test",
      startedAt: new Date().toISOString(),
      ensureChromeUpdater: false,
      runTmux: run,
      registry: {
        list: () => [...workspaces],
        add: (input) => {
          const workspace: Workspace = {
            ...input,
            sessionName: input.sessionName ?? input.name,
            ideConfigPath: input.ideConfigPath ?? null,
            addedAt: new Date().toISOString(),
          };
          workspaces.push(workspace);
          return workspace;
        },
      },
    });
    try {
      const operation = randomUUID();
      // Private socket isolation lets these sessions use visible catalog names;
      // a zz- session is intentionally omitted by production fleet discovery.
      const input = {
        displayName: "tmux-ide-practice-identity",
        cwd: root,
        includeLiveSessionId: true,
      };
      const created = await authority.createSession(operation, generation, input);
      expect(created.outcome).toBe("created");
      expect(created.liveSessionId).toMatch(/^live-session\.[a-f0-9]{20}$/u);
      const actual = discoverLiveSessionSummaries(run).find(
        (session) => session.sessionName === created.workspaceName,
      );
      expect(actual?.liveSessionId).toBe(created.liveSessionId);
      const nativeId = run(["list-sessions", "-F", "#{session_id}\t#{session_name}"])
        .split("\n")
        .find((line) => line.split("\t")[1] === created.workspaceName)
        ?.split("\t")[0];
      expect(nativeId).toMatch(/^\$\d+$/u);
      expect(created.liveSessionId).not.toBe(nativeId);
      expect(await authority.createSession(operation, generation, input)).toMatchObject({
        outcome: "replayed",
        liveSessionId: created.liveSessionId,
      });

      const legacy = await authority.createSession(randomUUID(), generation, {
        displayName: "tmux-ide-legacy-identity",
        cwd: root,
      });
      expect(legacy.outcome).toBe("created");
      expect(Object.hasOwn(legacy, "liveSessionId")).toBe(false);
      expect(discoverLiveSessionSummaries(run)).toHaveLength(2);
    } finally {
      spawnSync(executable, ["-S", socket, "kill-server"], {
        env,
        stdio: "ignore",
        timeout: 5_000,
      });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
