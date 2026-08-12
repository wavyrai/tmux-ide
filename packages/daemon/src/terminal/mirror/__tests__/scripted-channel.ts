import type { MirrorChannelHandlers } from "../control-channel.ts";
import {
  FIXTURE,
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  type FixtureState,
} from "./simulated-channel.ts";

export interface ScriptedChannelDriverOptions {
  readonly state?: FixtureState;
  readonly seedLines?: readonly string[];
  readonly cursorLine?: string;
  readonly maxTurns?: number;
}

/**
 * Scripted wrapper around the real control protocol simulator. It owns the
 * asynchronous capture/cursor choreography and exposes only bounded settling;
 * a broken bootstrap fails immediately instead of leaking a Vitest worker.
 */
export class ScriptedChannelDriver {
  readonly channel: SimulatedChannel;
  readonly #seedLines: readonly string[];
  readonly #cursorLine: string;
  readonly #maxTurns: number;
  #handledWrites = 0;
  readonly deferredCommands: string[] = [];

  constructor(handlers: MirrorChannelHandlers, options: ScriptedChannelDriverOptions = {}) {
    const state = options.state ?? fixtureState();
    this.#seedLines = options.seedLines ?? ["ready"];
    this.#cursorLine = options.cursorLine ?? "0 0 100 50";
    this.#maxTurns = options.maxTurns ?? 100;
    const basic = fixtureAutoReply(state);
    this.channel = new SimulatedChannel(handlers, (command) => {
      if (command.includes("capture-pane") || command.startsWith("display-message")) return null;
      return basic(command) ?? [];
    });
  }

  /** Complete every scripted probe written since the prior turn. */
  pump(): void {
    for (let index = this.#handledWrites; index < this.channel.written.length; index += 1) {
      const command = this.channel.written[index]!;
      if (command.includes("capture-pane") || command.startsWith("display-message")) {
        this.deferredCommands.push(command);
      }
    }
    this.#handledWrites = this.channel.written.length;
    while (this.deferredCommands.length > 0) {
      const command = this.deferredCommands.shift()!;
      if (command.includes("capture-pane")) this.channel.reply([...this.#seedLines]);
      else this.channel.reply([this.#cursorLine]);
    }
  }

  output(runtimePaneId: string, escapedControlBytes: string): void {
    this.channel.output(runtimePaneId, escapedControlBytes);
  }

  exit(reason = "detached"): void {
    this.channel.feedLines(`%exit ${reason}`);
  }

  async settleUntil(predicate: () => boolean, label: string): Promise<void> {
    for (let turn = 0; turn < this.#maxTurns; turn += 1) {
      this.pump();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (predicate()) return;
    }
    throw new Error(
      `Scripted channel did not settle ${label} within ${this.#maxTurns} turns; pending=${this.channel.core.pendingCount}; writes=${this.channel.written.join(" | ")}`,
    );
  }
}

export function standardScriptedChannel(
  handlers: MirrorChannelHandlers,
  options?: ScriptedChannelDriverOptions,
): ScriptedChannelDriver {
  return new ScriptedChannelDriver(handlers, {
    state: options?.state ?? {
      truthRows: [...FIXTURE.truthRows],
      windowRows: FIXTURE.windowRows(FIXTURE.layoutW1, FIXTURE.layoutW2),
      descriptorRows: [...FIXTURE.descriptorRows],
    },
    ...options,
  });
}
