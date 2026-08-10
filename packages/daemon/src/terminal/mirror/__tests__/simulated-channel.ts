/**
 * A simulated control-mode channel for MirrorService unit tests.
 *
 * Backed by the REAL {@link ControlChannelCore}, fed raw control-mode lines
 * (`%begin`/`%end` blocks, `%output`, notifications) — so the tests exercise
 * the genuine FIFO reply matching and synchronous dispatch the seed recipe's
 * gaplessness proof depends on, without a tmux process.
 *
 * Every command written pushes exactly one reply sink, so the simulator MUST
 * answer every command in write order. `autoReply` answers the boring ones
 * (identity join, stamping, fire-and-forget input) immediately; commands it
 * declines (returns null for) wait for a manual {@link reply}, letting a test
 * interleave `%output` lines between a probe and its reply.
 */
import {
  ControlChannelCore,
  type MirrorChannelHandlers,
  type MirrorChannelIo,
} from "../control-channel.ts";

export type AutoReply = (cmd: string) => string[] | null;

export class SimulatedChannel implements MirrorChannelIo {
  readonly core: ControlChannelCore;
  readonly written: string[] = [];
  disposed = false;
  private replyNum = 0;

  constructor(
    handlers: MirrorChannelHandlers,
    private readonly autoReply: AutoReply,
  ) {
    this.core = new ControlChannelCore(handlers);
  }

  start(): Promise<void> {
    const started = new Promise<void>((resolve, reject) => {
      this.core.push({ kind: "promise", resolve: () => resolve(), reject, lines: [] });
    });
    this.feedLines("%begin 1 0 0", "%end 1 0 0"); // the greeting block
    return started;
  }

  request(cmd: string): Promise<string[]> {
    const result = new Promise<string[]>((resolve, reject) => {
      this.core.push({ kind: "promise", resolve, reject, lines: [] });
    });
    this.record(cmd);
    return result;
  }

  commandInline(cmd: string, onReply: (reply: { ok: boolean; lines: string[] }) => void): void {
    this.core.push({ kind: "inline", onReply, lines: [] });
    this.record(cmd);
  }

  commandListInline(
    cmd: string,
    replyCount: number,
    resultIndex: number,
    onReply: (reply: { ok: boolean; lines: string[] }) => void,
  ): void {
    for (let index = 0; index < replyCount; index++) {
      this.core.push(
        index === resultIndex ? { kind: "inline", onReply, lines: [] } : { kind: "discard" },
      );
    }
    this.written.push(cmd);
    // The seed command-list is `set-option ; capture-pane`: acknowledge the
    // marker command now and leave the selected capture reply manual.
    this.reply([]);
  }

  send(cmd: string): void {
    this.core.push({ kind: "discard" });
    this.record(cmd);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }

  /** Feed a reply block for the OLDEST unanswered command. */
  reply(lines: string[], ok = true): void {
    this.replyNum += 1;
    this.feedLines(
      `%begin 1 ${this.replyNum} 1`,
      ...lines,
      `${ok ? "%end" : "%error"} 1 ${this.replyNum} 1`,
    );
  }

  /** Feed raw control-mode lines (notifications, `%output`, …). */
  feedLines(...lines: string[]): void {
    this.core.feed(lines.map((line) => `${line}\r\n`).join(""));
  }

  output(pane: string, text: string): void {
    this.feedLines(`%output ${pane} ${text}`);
  }

  private record(cmd: string): void {
    this.written.push(cmd);
    const auto = this.autoReply(cmd);
    if (auto) this.reply(auto);
  }
}

/** The standard 3-pane / 2-window fixture:
 *  `@1` (window.test.one, "main"): `%1` (pane.alpha, active) | `%2` (pane.beta)
 *  `@2` (window.test.two, "aux"):  `%3` (unstamped → generated + stamped back)
 */
export const FIXTURE = {
  session: "zz-sim",
  layoutW1: "aaaa,200x50,0,0{100x50,0,0,1,99x50,101,0,2}",
  layoutW2: "bbbb,200x50,0,0,3",
  truthRows: ["%1\t1\t@1\t1", "%2\t0\t@1\t1", "%3\t0\t@2\t0"],
  windowRows: (layoutW1: string, layoutW2: string): string[] => [
    `@1\twindow.test.one\tmain\t1\t${layoutW1}\t0`,
    `@2\twindow.test.two\taux\t0\t${layoutW2}\t0`,
  ],
  descriptorRows: [
    "%1\tpane.alpha\t\t\tzsh\t/tmp/a\t0\tmain\t@1\tAlpha",
    "%2\tpane.beta\t\t\tzsh\t/tmp/b\t0\tmain\t@1\tBeta",
    "%3\t\t\t\tzsh\t/tmp/c\t1\taux\t@2\tGamma",
  ],
};

export interface FixtureState {
  truthRows: string[];
  windowRows: string[];
  descriptorRows: string[];
}

/** Auto-reply script for the fixture: answers identity-join and input
 *  commands, leaves capture/cursor probes (and anything unrecognized) manual. */
export function fixtureAutoReply(state: FixtureState): AutoReply {
  return (cmd) => {
    if (cmd.includes("qa:@tmux_ide_pane_id")) return state.descriptorRows;
    if (cmd.startsWith("list-panes -s")) return state.truthRows;
    if (cmd.startsWith("list-windows")) return state.windowRows;
    // Product-owned seeds are one atomic `set-option ; capture-pane` command
    // list. The capture reply remains manual just like a bare capture probe.
    if (cmd.includes("capture-pane")) return null;
    if (cmd.startsWith("set-option")) return [];
    if (cmd.startsWith("send-keys") || cmd.startsWith("refresh-client")) return [];
    return null; // capture-pane / display-message: manual
  };
}

export function fixtureState(): FixtureState {
  return {
    truthRows: [...FIXTURE.truthRows],
    windowRows: FIXTURE.windowRows(FIXTURE.layoutW1, FIXTURE.layoutW2),
    descriptorRows: [...FIXTURE.descriptorRows],
  };
}
