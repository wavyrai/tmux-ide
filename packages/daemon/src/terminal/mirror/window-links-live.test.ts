import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import type { MirrorLayoutAuthoritySnapshot } from "./events.ts";

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "projects native duplicate links and selects/unlinks through the retained control channel",
  async () => {
    const root = mkdtempSync("/tmp/tmi-links-");
    const socketPath = join(root, "s");
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-S", socketPath, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
        timeout: 3000,
      }).trimEnd();
    const mirror = new MirrorService({
      socketPath,
      createIo: (session, handlers) =>
        new MirrorControlChannel({ session, handlers, socketPath, configFile: "/dev/null" }),
    });
    try {
      tmux("new-session", "-d", "-s", "zz-links", "sleep 300");
      tmux("link-window", "-s", "zz-links:0", "-t", "zz-links:1");
      const snapshots: MirrorLayoutAuthoritySnapshot[] = [];
      const identity = await mirror.describeSessionAuthority("zz-links");
      const retention = await mirror.retainSession("zz-links");
      const sub = await mirror.subscribeLayout("zz-links", () => {}, {
        expectedRuntimeSessionId: "$0",
        expectedSemanticPaneIds: identity.description.panes.map((pane) => pane.semanticPaneId),
        onAuthority: (snapshot) => snapshots.push(snapshot),
      });
      const initial = snapshots.at(-1)!;
      expect(initial.layouts).toHaveLength(1);
      expect(initial.windowLinks.links).toHaveLength(2);
      const originalStamp = tmux("show-options", "-wqv", "-t", "zz-links:0", "@tmux_ide_window_id");
      tmux("select-window", "-t", "zz-links:1");
      await vi.waitFor(() =>
        expect(snapshots.at(-1)!.windowLinks.activeLinkId).toBe(
          initial.windowLinks.links[1]!.linkId,
        ),
      );
      tmux("select-window", "-t", "zz-links:0");
      await vi.waitFor(() =>
        expect(snapshots.at(-1)!.windowLinks.activeLinkId).toBe(
          initial.windowLinks.links[0]!.linkId,
        ),
      );
      expect(tmux("show-options", "-wqv", "-t", "zz-links:0", "@tmux_ide_window_id")).toBe(
        originalStamp,
      );
      const pane = initial.layouts[0]!.panes[0]!.semanticPaneId!;
      await expect(
        mirror.executeWindowLinkAction("zz-links", { action: "select", paneId: pane }),
      ).rejects.toMatchObject({ reason: "window_link_ambiguous" });
      const link = initial.windowLinks.links[1]!;
      const target = {
        liveSessionId: initial.windowLinks.liveSessionId,
        linkRevision: initial.windowLinks.linkRevision,
        linkId: link.linkId,
        expectedSemanticWindowId: link.semanticWindowId,
      };
      expect(
        (
          await mirror.executeWindowLinkAction("zz-links", {
            action: "select",
            target,
            paneId: pane,
          })
        ).outcome,
      ).toBe("applied");
      expect(tmux("display-message", "-p", "-t", "zz-links", "#{window_index}")).toBe("1");
      await vi.waitFor(() => expect(snapshots.at(-1)!.windowLinks.activeLinkId).toBe(link.linkId));
      expect(
        (await mirror.executeWindowLinkAction("zz-links", { action: "unlink", target })).outcome,
      ).toBe("applied");
      expect(tmux("list-windows", "-t", "zz-links", "-F", "#{window_index}")).toBe("0");
      expect(snapshots.at(-1)!.layouts).toHaveLength(1);
      expect(snapshots.at(-1)!.windowLinks.links).toHaveLength(1);
      expect((await mirror.describeSessionAuthority("zz-links")).description.panes).toHaveLength(1);
      await expect(
        mirror.executeWindowLinkAction("zz-links", { action: "select", target }),
      ).rejects.toMatchObject({ reason: "window_link_stale" });
      const remaining = snapshots.at(-1)!.windowLinks;
      const survivor = remaining.links[0]!;
      expect(
        (
          await mirror.executeWindowLinkAction("zz-links", {
            action: "unlink",
            target: {
              liveSessionId: remaining.liveSessionId,
              linkRevision: remaining.linkRevision,
              linkId: survivor.linkId,
              expectedSemanticWindowId: survivor.semanticWindowId,
            },
          })
        ).outcome,
      ).toBe("native-refused");
      expect((await mirror.describeSessionAuthority("zz-links")).description.panes).toHaveLength(1);
      await sub.close();
      await retention.close();
    } finally {
      await mirror.dispose();
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

it
  .skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)
  .each(["before-validation", "after-validation"])(
  "refuses replacement at %s with reused native IDs",
  async (phase) => {
    const root = mkdtempSync("/tmp/tmi-link-replace-");
    const socketPath = join(root, "s");
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-S", socketPath, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
        timeout: 3000,
      }).trimEnd();
    const { buildNativeWindowLinkGuard } = await import("../../lib/tmux-window-link-guard.ts");
    const executable = execFileSync("/bin/sh", ["-c", "command -v tmux"], {
      encoding: "utf8",
    }).trim();
    const wrapper = join(root, "replace-before-exec");
    writeFileSync(
      wrapper,
      `#!/bin/sh\n'${executable}' -S '${socketPath}' kill-server\n'${executable}' -S '${socketPath}' -f /dev/null new-session -d -s zz-replace 'sleep 300'\n'${executable}' -S '${socketPath}' link-window -s zz-replace:0 -t zz-replace:1\nexec '${executable}' "$@"\n`,
      { mode: 0o700 },
    );
    const mirror = new MirrorService({
      socketPath,
      executable: phase === "after-validation" ? wrapper : executable,
      createIo: (session, handlers) =>
        new MirrorControlChannel({ session, handlers, socketPath, configFile: "/dev/null" }),
    });
    try {
      tmux("new-session", "-d", "-s", "zz-replace", "sleep 300");
      tmux("link-window", "-s", "zz-replace:0", "-t", "zz-replace:1");
      const originalPid = tmux("display-message", "-p", "#{pid}");
      const created = tmux("display-message", "-p", "#{session_created}");
      const retention = await mirror.retainSession("zz-replace");
      const authority = await mirror.describeSessionAuthority("zz-replace");
      let snapshot!: MirrorLayoutAuthoritySnapshot;
      const sub = await mirror.subscribeLayout("zz-replace", () => {}, {
        expectedRuntimeSessionId: "$0",
        expectedSemanticPaneIds: authority.description.panes.map((pane) => pane.semanticPaneId),
        onAuthority: (value) => {
          snapshot = value;
        },
      });
      const link = snapshot.windowLinks.links[1]!;
      const target = {
        liveSessionId: snapshot.windowLinks.liveSessionId,
        linkRevision: snapshot.windowLinks.linkRevision,
        linkId: link.linkId,
        expectedSemanticWindowId: link.semanticWindowId,
      };
      if (phase === "before-validation") {
        tmux("kill-server");
        tmux("new-session", "-d", "-s", "zz-replace", "sleep 300");
        tmux("link-window", "-s", "zz-replace:0", "-t", "zz-replace:1");
      }
      const guard = buildNativeWindowLinkGuard(
        {
          sessionId: "$0",
          windowIndex: 1,
          expectedWindowId: "@0",
          expectedServerPid: originalPid,
          expectedSessionCreated: created,
        },
        "unlink",
      );
      try {
        const result = await mirror.executeWindowLinkAction("zz-replace", {
          action: "unlink",
          target,
        });
        expect(result.outcome).not.toBe("applied");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(tmux(...guard)).toBe("link-guard.stale");
      expect(tmux("list-windows", "-t", "zz-replace", "-F", "#{window_index}")).toBe("0\n1");
      await sub.close();
      await retention.close();
    } finally {
      await mirror.dispose();
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
