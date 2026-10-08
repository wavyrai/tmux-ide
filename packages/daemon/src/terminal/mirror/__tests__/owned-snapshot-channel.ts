import type {
  AtomicPaneSnapshotCollector,
  AtomicPaneSnapshotFailureReason,
  ControlReply,
  MirrorChannelHandlers,
} from "../control-channel.ts";
import { SimulatedChannel, type AutoReply } from "./simulated-channel.ts";

/** Opt-in stock hook executor for adjacent service tests. All transaction bytes
 * pass through the real parser; ordinary command replies retain their FIFO slots.
 * The fixture models the owned, synchronous NOHOOKS command sequence, not PTY timing. */
export class OwnedSnapshotChannel extends SimulatedChannel {
  private collector: AtomicPaneSnapshotCollector | null = null;
  private rawNumber = 10000;
  constructor(
    handlers: MirrorChannelHandlers,
    autoReply: AutoReply,
    private readonly seed: () => readonly string[],
    private readonly cursor: (pane: string) => string,
  ) {
    super(handlers, (command) => {
      const fence = /^display-message -p -l (tmux-ide-snapshot-admission:[a-f0-9]+)$/u.exec(
        command,
      );
      if (fence) return [fence[1]!];
      return autoReply(command);
    });
  }
  override reply(lines: string[], ok = true): void {
    // Real server replies cannot reenter a parser callback while its raw block
    // is settling. Preserve queued write order at the next microtask boundary.
    queueMicrotask(() => super.reply(lines, ok));
  }
  armAtomicPaneSnapshotCollector(spec: AtomicPaneSnapshotCollector): boolean {
    const accepted = this.core.armAtomicPaneSnapshotCollector({
      ...spec,
      onDrained: (reason) => {
        if (this.collector?.nonce === spec.nonce) this.collector = null;
        spec.onDrained?.(reason);
      },
    });
    if (accepted) this.collector = spec;
    return accepted;
  }
  retireAtomicPaneSnapshotCollector(
    nonce: string,
    reason: AtomicPaneSnapshotFailureReason = "retired",
  ): void {
    if (!this.core.retireAtomicPaneSnapshotCollector(nonce, reason)) return;
    // A separate ordinary FIFO fence, never a captured sentinel, releases debt.
    this.commandInline(`display-message -p -l tmux-ide-snapshot-admission:${nonce}`, (reply) => {
      if (reply.ok && reply.lines[0] === `tmux-ide-snapshot-admission:${nonce}`)
        this.core.releaseRetiredCollector(nonce);
    });
  }
  override commandListInline(
    command: string,
    count: number,
    resultIndex: number,
    onReply: (reply: ControlReply) => void,
  ): void {
    super.commandListInline(command, count, resultIndex, onReply);
    const spec = this.collector;
    if (!spec || !command.includes("set-hook -Rp")) return;
    queueMicrotask(() => {
      if (this.disposed) return;
      const marker = (name: string) => `%tmux-ide-atomic-v1 ${spec.nonce} ${name}`;
      const blocks: readonly string[][] =
        spec.kind === "pause"
          ? [[marker("start")], [`%pause ${spec.runtimePaneId}`], [marker("complete")]]
          : [
              [marker("start")],
              [...this.seed()],
              [marker("capture-end")],
              ...(spec.dualCapture ? [[...this.seed()], [marker("ansi-capture-end")]] : []),
              [this.cursor(spec.runtimePaneId)],
              [marker("cursor-end")],
              [`%continue ${spec.runtimePaneId}`],
              ...Array.from({ length: spec.observerCommandCount }, () => []),
              [],
              [],
              [marker("status-ok")],
              [],
              [marker("complete")],
            ];
      for (const lines of blocks) {
        const number = ++this.rawNumber;
        this.feedLines(`%begin 1 ${number} 0`, ...lines, `%end 1 ${number} 0`);
      }
    });
  }
}
