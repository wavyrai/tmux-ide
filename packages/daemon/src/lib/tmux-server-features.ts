import { nativeSplitCapability } from "../terminal/protocol/native-split-resize.ts";

/** Runs one tmux command against a server and returns its stdout; throws with stderr. */
export type TmuxProbe = (args: readonly string[]) => string;
const UNKNOWN = (command: string) => new RegExp(`^unknown command: ${command}$`, "mu");

export type NativeAnswer = "full" | "stock" | "older" | "partial" | "no-server" | "unknown";
/** The same reading of the server as the mirror's: the stock resize when it refuses
 * the split command by name, and full only with the split capability it requires. */
export function nativeCommands(probe: TmuxProbe): NativeAnswer {
  const ask = (command: string) => {
    try {
      return { output: probe([command, "-V"]) };
    } catch (error) {
      const failure = error as { stderr?: unknown; message?: string };
      return { failure: String(failure.stderr ?? failure.message ?? "") };
    }
  };
  const split = ask("tmux-ide-resize-split");
  const events = ask("tmux-ide-events");
  const failures = [split.failure, events.failure].filter((text) => text !== undefined);
  if (failures.some((text) => /no server running|error connecting/u.test(text!)))
    return "no-server";
  const refused = (answer: { failure?: string }, command: string) =>
    answer.failure !== undefined && UNKNOWN(command).test(answer.failure);
  if (refused(split, "tmux-ide-resize-split")) {
    if (refused(events, "tmux-ide-events")) return "stock";
    // The journal answers: a tmux-ide tmux built before the split command.
    if (events.output !== undefined) return "older";
    return "unknown";
  }
  if (split.output !== undefined && events.output !== undefined) {
    try {
      return nativeSplitCapability(split.output) ? "full" : "partial";
    } catch {
      return "partial";
    }
  }
  return failures.length === 2 ? "unknown" : "partial";
}

/** The answers a live server can give (doctor also reports "no-server"). */
export type ServerFeatures = Exclude<NativeAnswer, "no-server">;
