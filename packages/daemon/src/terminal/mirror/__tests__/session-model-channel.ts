import {
  ControlChannelCore,
  type AtomicPaneSnapshotCollector,
  type AtomicPaneSnapshotFailureReason,
  type ControlReply,
  type ControlReplyLimits,
  type MirrorChannelHandlers,
  type MirrorChannelIo,
} from "../control-channel.ts";
import { fixtureAutoReply, fixtureState } from "./simulated-channel.ts";

export type ModelFrame = {
  text: string;
  kind: "ordinary" | "hook" | "output" | "exit";
  id: number;
  pane?: string;
};
export type ModelCut = {
  pane: string;
  nonce: string;
  text: string;
  participants: readonly string[];
  generation: number;
};
export interface ModelDriverObserver {
  trace(event: Record<string, unknown>): void;
  context(pane: string): { participants: readonly string[]; generation: number };
  cut(cut: ModelCut): void;
  schedule(callback: () => void, delay: number): () => void;
}
export class ModelHarnessError extends Error {}

/** Deterministic test server, not a snapshot reducer. Server execution and wire
 * delivery are separate turns; emitted commands are checked before any reply. */
export class SessionModelChannel implements MirrorChannelIo {
  readonly core: ControlChannelCore;
  readonly commands: Array<{ id: number; text: string; slots: number }> = [];
  readonly frames: ModelFrame[] = [];
  readonly wire: ModelFrame[] = [];
  readonly reads: string[] = [];
  readonly world = new Map([
    ["%1", ""],
    ["%2", ""],
  ]);
  readonly paused = new Set<string>();
  readonly arms: Array<{ nonce: string; kind: string; pane: string }> = [];
  readonly drains: Array<{ nonce: string; reason: string }> = [];
  disposed = false;
  private readonly jobs: Array<() => void> = [];
  private readonly options = new Map<string, string>();
  private readonly fixture = fixtureAutoReply(fixtureState());
  private collector: AtomicPaneSnapshotCollector | null = null;
  private context: ReturnType<ModelDriverObserver["context"]> | null = null;
  private readonly retiring = new Set<string>();
  private readonly completed = new Set<string>();
  private number = 0;
  private commandId = 0;
  failNextCapture = false;
  snapshotExecutions = 0;
  constructor(
    handlers: MirrorChannelHandlers,
    private readonly observer: ModelDriverObserver,
  ) {
    this.core = new ControlChannelCore(handlers);
  }
  start(): Promise<void> {
    const result = new Promise<void>((resolve, reject) =>
      this.core.push({ kind: "promise", resolve: () => resolve(), reject, lines: [] }),
    );
    this.block(0, [], "ordinary");
    return result;
  }
  request(command: string): Promise<string[]> {
    const result = new Promise<string[]>((resolve, reject) =>
      this.core.push({ kind: "promise", resolve, reject, lines: [] }),
    );
    this.enqueue(command, 1, 0);
    return result;
  }
  commandInline(command: string, onReply: (reply: ControlReply) => void): void {
    this.core.push({ kind: "inline", onReply, lines: [] });
    this.enqueue(command, 1, 0);
  }
  send(command: string, onReply?: (reply: ControlReply) => void): void {
    this.core.push({ kind: "discard", ...(onReply ? { onReply } : {}) });
    this.enqueue(command, 1, 0);
  }
  commandListInline(
    command: string,
    count: number,
    index: number,
    onReply: (reply: ControlReply) => void,
  ): void {
    this.core.pushCommandList(count, index, onReply);
    this.enqueue(command, count, index);
  }
  commandListBoundedInline(
    command: string,
    count: number,
    index: number,
    limits: ControlReplyLimits,
    onReply: (reply: ControlReply) => void,
  ): void {
    if (!this.core.pushBoundedCommandList(count, index, limits, onReply)) {
      onReply({ ok: false, lines: [] });
      return;
    }
    this.enqueue(command, count, index);
  }
  armAtomicPaneSnapshotCollector(spec: AtomicPaneSnapshotCollector, timeoutMs: number): boolean {
    let cancelTimeout = () => {};
    const context = this.observer.context(spec.runtimePaneId);
    const accepted = this.core.armAtomicPaneSnapshotCollector({
      ...spec,
      onSettled: (result) => {
        cancelTimeout();
        if (
          !result.ok &&
          result.failureReason !== "channel-exit" &&
          !this.retiring.has(spec.nonce)
        ) {
          this.drain(spec.nonce, result.failureReason ?? "retired", () => spec.onSettled(result));
        } else spec.onSettled(result);
      },
      onDrained: (reason) => {
        cancelTimeout();
        this.observer.trace({ type: "drained", nonce: spec.nonce, reason });
        this.drains.push({ nonce: spec.nonce, reason });
        if (this.collector?.nonce === spec.nonce) this.collector = null;
        spec.onDrained?.(reason);
      },
    });
    if (accepted) {
      cancelTimeout = this.observer.schedule(
        () => this.retireAtomicPaneSnapshotCollector(spec.nonce, "timeout"),
        timeoutMs,
      );
      this.observer.trace({
        type: "armed",
        nonce: spec.nonce,
        kind: spec.kind ?? "snapshot",
        pane: spec.runtimePaneId,
      });
      this.collector = spec;
      this.context = context;
      this.arms.push({
        nonce: spec.nonce,
        kind: spec.kind ?? "snapshot",
        pane: spec.runtimePaneId,
      });
    }
    return accepted;
  }
  retireAtomicPaneSnapshotCollector(
    nonce: string,
    reason: AtomicPaneSnapshotFailureReason = "retired",
  ): void {
    this.drain(nonce, reason);
  }
  private drain(nonce: string, reason: AtomicPaneSnapshotFailureReason, settle?: () => void): void {
    if (this.collector?.nonce !== nonce || this.retiring.has(nonce) || this.completed.has(nonce))
      return;
    this.retiring.add(nonce);
    this.core.retireAtomicPaneSnapshotCollector(nonce, reason);
    settle?.();
    const token = `tmux-ide-snapshot-admission:${nonce}`;
    this.commandInline(`display-message -p -l ${token}`, (reply) => {
      if (reply.ok && reply.lines.length === 1 && reply.lines[0] === token)
        this.core.releaseRetiredCollector(nonce);
    });
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
  private block(flags: number, lines: readonly string[], kind: ModelFrame["kind"]): void {
    const id = ++this.number;
    this.frames.push({
      id,
      kind,
      text: [`%begin 1 ${id} ${flags}`, ...lines, `%end 1 ${id} ${flags}`, ""].join("\n"),
    });
  }
  private enqueue(text: string, slots: number, resultIndex: number): void {
    this.commands.push({ id: ++this.commandId, text, slots });
    this.observer.trace({ type: "command", id: this.commandId, text, slots });
    this.jobs.push(() => {
      const install = /^set-option -po -t (%\d+) (@tmux_ide_(?:pause|atomic)[^ ]*) (.+)$/u.exec(
        text,
      );
      const invoke = /set-hook -Rp -t (%\d+) (@tmux_ide_(?:pause|atomic)_[a-f0-9]+)/u.exec(text);
      let reply: string[] | null;
      if (install) {
        this.options.set(
          install[2]!,
          install[3]!.replace(/^'/u, "").replace(/'$/u, "").replaceAll("'\\''", "'"),
        );
        reply = [];
      } else if (invoke) reply = [];
      else if (text.startsWith("display-message -p -l tmux-ide-snapshot-admission:"))
        reply = [text.slice("display-message -p -l ".length)];
      else {
        const discovery =
          text.startsWith('display-message -p "#{qa:session_name}') ||
          text.startsWith('list-panes -s -t "zz-sim" -F ') ||
          text.startsWith('list-windows -t "zz-sim" -F ');
        const subscription =
          /^refresh-client -B 'tmux-ide-(?:pane-borders|copy-keys|pane-history|scroll-on-clear):[^']+'$/u.test(
            text,
          );
        const stamp = /^set-option -p -t %3 @tmux_ide_pane_id "pane\.mirror\.gen1"$/u.test(text);
        const resume = /^refresh-client -A '%[12]:(?:continue|pause)'$/u.test(text);
        const cleanup =
          text.startsWith("if-shell -t %") &&
          text.includes("set-option -pu -t ") &&
          /@tmux_ide_(?:pause_|atomic_|read_operation)/u.test(text) &&
          !text.includes("set-hook") &&
          (!/capture-pane|run-shell|send-keys|refresh-client|wait-for/u.test(text) ||
            text.endsWith("'display-message -p -l pause-cleanup-skipped'"));
        if (!discovery && !subscription && !stamp && !resume && !cleanup)
          throw new ModelHarnessError(`Unsupported emitted command: ${text}`);
        reply = this.fixture(text);
      }
      if (reply === null) throw new ModelHarnessError(`Unsupported emitted command: ${text}`);
      for (let index = 0; index < slots; index++)
        this.block(1, index === resultIndex ? reply : [], "ordinary");
      if (invoke) {
        const spec = this.collector;
        const context = this.context;
        const body = this.options.get(invoke[2]!);
        if (
          !spec ||
          !context ||
          !body ||
          spec.runtimePaneId !== invoke[1] ||
          !body.includes(spec.nonce)
        )
          throw new ModelHarnessError("Hook invocation lacks installed owned body");
        if (spec.kind !== "pause") {
          if (
            this.options.get(`@tmux_ide_atomic_owner_${spec.nonce}`) !== spec.nonce ||
            this.options.get(`@tmux_ide_atomic_expected_${spec.nonce}`) !== body
          )
            throw new ModelHarnessError("Unowned or substituted snapshot hook");
        }
        this.executeHook(spec, context, body);
      }
      const ordinaryPause = /^refresh-client -A '(%\d+):pause'$/u.exec(text);
      if (ordinaryPause) this.pause(ordinaryPause[1]!);
      const ordinaryContinue = /^refresh-client -A '(%\d+):continue'$/u.exec(text);
      if (ordinaryContinue) this.paused.delete(ordinaryContinue[1]!);
    });
  }
  private executeHook(
    spec: AtomicPaneSnapshotCollector,
    context: ReturnType<ModelDriverObserver["context"]>,
    body: string,
  ): void {
    const pane = spec.runtimePaneId;
    const marker = (name: string) => `%tmux-ide-atomic-v1 ${spec.nonce} ${name}`;
    if (spec.kind === "pause") {
      if (
        !body.includes(`${pane}:pause`) ||
        body.includes("capture-pane") ||
        !body.includes(" complete")
      )
        throw new ModelHarnessError("Invalid pause program");
      const already = this.paused.has(pane);
      this.paused.add(pane);
      this.block(0, [marker("start")], "hook");
      this.block(0, already ? [] : [`%pause ${pane}`], "hook");
      this.block(0, [marker("complete")], "hook");
      return;
    }
    const capture = body.indexOf(`capture-pane -p -e -J -S - -t ${pane}`);
    const cursor = body.indexOf("#{cursor_x}");
    const resume = body.indexOf(`${pane}:continue`);
    if (
      capture < 0 ||
      cursor <= capture ||
      resume <= cursor ||
      spec.observerCommandCount !== 0 ||
      spec.dualCapture ||
      /run-shell|if-shell -b|wait-for/u.test(body)
    )
      throw new ModelHarnessError("Unsupported non-atomic snapshot program");
    let previous = -1;
    for (const guard of ["start", "capture-end", "cursor-end", "status-ok", "complete"]) {
      const at = body.indexOf(marker(guard));
      if (at <= previous || body.indexOf(marker(guard), at + 1) >= 0)
        throw new ModelHarnessError(`Invalid guard ${guard}`);
      previous = at;
    }
    this.snapshotExecutions++;
    if (this.failNextCapture) {
      this.failNextCapture = false;
      this.block(0, [marker("start")], "hook");
      const id = ++this.number;
      this.frames.push({
        id,
        kind: "hook",
        text: `%begin 1 ${id} 0\nmodel capture command failed\n%error 1 ${id} 0\n`,
      });
      // tmux aborts remaining commands in this failing hook group. The
      // separately queued cleanup and ordinary drain fence still execute.
      return;
    }
    const text = this.world.get(pane)!;
    this.observer.trace({ type: "cut", pane, nonce: spec.nonce, text, ...context });
    this.observer.cut({ pane, nonce: spec.nonce, text, ...context });
    this.paused.delete(pane);
    const cols = pane === "%1" ? 100 : 99;
    const blocks = [
      [marker("start")],
      [text],
      [marker("capture-end")],
      [`${text.length} 0 ${cols} 50`],
      [marker("cursor-end")],
      [`%continue ${pane}`],
      [],
      [],
      [marker("status-ok")],
      [],
      [marker("complete")],
    ];
    for (const lines of blocks) this.block(0, lines, "hook");
  }
  /** One server operation or one already ordered wire batch, never recursive. */
  step(partition: number): boolean {
    if (this.disposed) return false;
    if (this.frames.length) {
      this.deliver(partition);
      return true;
    }
    const job = this.jobs.shift();
    if (!job) return false;
    job();
    return true;
  }
  /** Execute the queued hook without delivering it, exposing the proven
   * post-capture output-before-reply schedule to the generator. */
  execute(): boolean {
    if (this.disposed || this.frames.length) return false;
    const job = this.jobs.shift();
    if (!job) return false;
    job();
    return true;
  }
  pause(pane: string): void {
    this.paused.add(pane);
    this.frames.push({ id: ++this.number, pane, kind: "output", text: `%pause ${pane}\n` });
  }
  produce(pane: string, text: string): void {
    this.world.set(pane, this.world.get(pane)! + text);
    if (this.paused.has(pane)) return;
    const encoded = [...Buffer.from(text)]
      .map((byte) =>
        byte < 32 || byte === 92
          ? `\\${byte.toString(8).padStart(3, "0")}`
          : String.fromCharCode(byte),
      )
      .join("");
    const frame = {
      id: ++this.number,
      pane,
      kind: "output" as const,
      text: `%output ${pane} ${encoded}\n`,
    };
    // tmux's per-pane scheduler may put output before queued reply lines.
    const firstHook = this.frames.findIndex((candidate) => candidate.kind === "hook");
    if (firstHook >= 0) this.frames.splice(firstHook, 0, frame);
    else this.frames.push(frame);
  }
  deliver(partition: number): void {
    const frames = this.frames.splice(0);
    this.wire.push(...frames);
    this.observer.trace({ type: "wire", frameIds: frames.map((frame) => frame.id) });
    const wire = frames.map((frame) => frame.text).join("");
    for (let offset = 0; offset < wire.length; ) {
      const size =
        partition === 0 ? wire.length : partition === 1 ? 1 : 1 + ((offset * 13 + partition) % 97);
      const chunk = wire.slice(offset, offset + size);
      this.reads.push(chunk);
      this.core.feed(chunk);
      offset += chunk.length;
    }
  }
  disconnect(): void {
    this.frames.length = 0;
    this.jobs.length = 0;
    this.core.feed("%exit model disconnect\n");
    this.disposed = true;
  }
  get collectorIdle(): boolean {
    return this.collector === null;
  }
  get pending(): number {
    return this.frames.length + this.jobs.length;
  }
}
