import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import type { MirrorPaneEvent } from "./events.ts";
import { MirrorService } from "./mirror-service.ts";
import type { MirrorFlowRecoveryObservation } from "./session-channel.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-recovery-${process.pid}-${randomUUID().slice(0, 8)}`;
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
afterAll(() => {
  spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
});

describe.skipIf(!available)("native control-mode recovery", () => {
  it.each([0, 9000])(
    "recovers both subscribers with %i history lines across repeated native freeze and thaw cycles",
    async (historyRows) => {
      const session = `recovery-${historyRows}`;
      tmux("new-session", "-d", "-s", session, "-x", "80", "-y", "24", "sh");
      tmux("set-option", "-t", session, "history-limit", "20000");
      tmux("new-window", "-t", session, "-n", "history", "sh");
      const runtimePane = tmux("display-message", "-p", "-t", session, "#{pane_id}");
      if (historyRows > 0) {
        tmux(
          "send-keys",
          "-t",
          runtimePane,
          `i=0; while [ "$i" -lt ${historyRows} ]; do printf 'HISTORY-%s\\n' "$i"; i=$((i+1)); done`,
          "Enter",
        );
        await vi.waitFor(() =>
          expect(tmux("capture-pane", "-p", "-t", runtimePane)).toContain(
            `HISTORY-${historyRows - 1}`,
          ),
        );
      }
      tmux("send-keys", "-t", runtimePane, "printf 'RECOVERY_%s\\n' READY", "Enter");
      await vi.waitFor(() =>
        expect(tmux("capture-pane", "-p", "-t", runtimePane)).toContain("RECOVERY_READY"),
      );
      let io: MirrorControlChannel | undefined;
      const observations: MirrorFlowRecoveryObservation[] = [];
      const events: MirrorPaneEvent[] = [];
      const siblingEvents: MirrorPaneEvent[] = [];
      const service = new MirrorService({
        createIo: (session, handlers) => {
          io = new MirrorControlChannel({ session, handlers, socketName, configFile: "/dev/null" });
          return io;
        },
        internalReadHookEmission: (pane, marker) => ({
          bufferName: "recovery-observer",
          signalChannel: "recovery-observer",
          record: `${pane}|${marker}|workspace.pane.read|`,
        }),
        onFlowRecoveryObserved: (_session, observation) => observations.push(observation),
      });
      try {
        const described = await service.describeSession(session);
        const pane = described.panes.find((pane) => pane.windowName === "history")!;
        const subscription = await service.subscribe({
          session,
          semanticPaneId: pane.semanticPaneId,
          onEvent: (event) => events.push(event),
        });
        const sibling = await service.subscribe({
          session,
          semanticPaneId: pane.semanticPaneId,
          onEvent: (event) => siblingEvents.push(event),
        });
        await vi.waitFor(() => {
          expect(events.some((event) => event.type === "seed")).toBe(true);
          expect(siblingEvents.some((event) => event.type === "seed")).toBe(true);
        });
        tmux("send-keys", "-t", runtimePane, "printf 'LIVE_%s\\n' OUTPUT", "Enter");
        await vi.waitFor(() => expect(events.some((event) => event.type === "delta")).toBe(true));
        // This bare service has no production after-capture observer hook. Consume
        // its initial seed marker before testing the self-contained recovery hook.
        tmux("set-option", "-pu", "-t", runtimePane, "@tmux_ide_read_operation");
        for (let cycle = 0; cycle < 3; cycle += 1) {
          events.length = 0;
          siblingEvents.length = 0;
          observations.length = 0;
          subscription.freeze();
          sibling.freeze();
          await io!.request("display-message -p freeze-fence");
          const marker = `RESUMED_${cycle}`;
          tmux("send-keys", "-t", runtimePane, `printf 'RESUMED_%s\\n' ${cycle}`, "Enter");
          await vi.waitFor(() =>
            expect(tmux("capture-pane", "-p", "-t", runtimePane)).toContain(marker),
          );
          expect(events.some((event) => event.type === "delta")).toBe(false);
          subscription.thaw();
          sibling.thaw();
          await vi.waitFor(
            () => {
              expect(observations.map((observation) => observation.phase)).toContain("converged");
            },
            { timeout: 6000 },
          );
          expect(observations.some((observation) => observation.phase === "nonconverged")).toBe(
            false,
          );
          expect(events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
            true,
          );
          expect(
            events
              .filter((event) => event.type === "seed")
              .map((event) => new TextDecoder().decode(event.data))
              .join(""),
          ).toContain(marker);
          expect(
            siblingEvents
              .filter((event) => event.type === "seed")
              .map((event) => new TextDecoder().decode(event.data))
              .join(""),
          ).toContain(marker);
          const native = tmux("capture-pane", "-p", "-e", "-J", "-S", "-", "-t", runtimePane);
          for (const received of [events, siblingEvents]) {
            const seed = received.filter((event) => event.type === "seed").at(-1)!;
            expect(new TextDecoder().decode(seed.data).replaceAll("\r\n", "\n").trimEnd()).toBe(
              native,
            );
          }
          await vi.waitFor(() =>
            expect(tmux("show-options", "-p", "-t", runtimePane)).not.toContain(
              "@tmux_ide_atomic_",
            ),
          );
        }
      } finally {
        await service.dispose();
      }
    },
    15000,
  );
});
