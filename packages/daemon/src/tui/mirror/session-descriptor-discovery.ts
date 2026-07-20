export interface SessionPaneDescriptor {
  runtimePaneId: string;
  semanticPaneId: string | null;
  role: string | null;
  type: string | null;
  currentCommand: string | null;
  cwd: string | null;
  title: string | null;
  windowIndex: number | null;
  windowName: string | null;
  windowId: string | null;
}

/**
 * `qa` asks tmux to escape each value as a command argument. In particular,
 * embedded tabs/newlines/backslashes become escapes, leaving our record tabs
 * unambiguous. This modifier is supported by the tmux version we already use
 * for control-mode mirroring.
 */
export const SESSION_PANE_DESCRIPTOR_FORMAT = [
  "#{pane_id}",
  "#{qa:@tmux_ide_pane_id}",
  "#{qa:@ide_role}",
  "#{qa:@ide_type}",
  "#{qa:pane_current_command}",
  "#{qa:pane_current_path}",
  "#{window_index}",
  "#{qa:window_name}",
  "#{window_id}",
  "#{qa:pane_title}",
].join("\t");

/** Decode the escapes emitted by tmux's `qa` format modifier. */
export function decodeTmuxArgument(value: string): string {
  const encoded =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  let decoded = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const current = encoded[index]!;
    if (current !== "\\" || index + 1 >= encoded.length) {
      decoded += current;
      continue;
    }
    const escaped = encoded[++index]!;
    if (escaped === "e") decoded += "\x1b";
    else if (escaped === "n") decoded += "\n";
    else if (escaped === "r") decoded += "\r";
    else if (escaped === "t") decoded += "\t";
    else if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(encoded[index + 1] ?? "")) {
        octal += encoded[++index]!;
      }
      decoded += String.fromCodePoint(Number.parseInt(octal, 8));
    } else if (escaped === "u") {
      const remaining = encoded.slice(index + 1);
      const unicode = remaining.match(/^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{4})/u)?.[0];
      if (unicode) {
        decoded += String.fromCodePoint(Number.parseInt(unicode, 16));
        index += unicode.length;
      } else {
        decoded += "u";
      }
    } else {
      decoded += escaped;
    }
  }
  return decoded;
}

interface ParsedSessionPaneDescriptorReply {
  descriptors: SessionPaneDescriptor[];
  malformedUtf8Records: number;
}

/**
 * PURE — parse one qa-escaped, tab-delimited descriptor record per pane.
 * ControlModeClient deliberately exposes stdout as latin1 so each JS code
 * unit preserves one wire byte. Recover UTF-8 before interpreting tmux's
 * ASCII qa escapes; doing it afterwards would leave non-ASCII metadata as
 * mojibake while decoding the whole string with the default replacement mode
 * would silently persist corrupt metadata.
 */
export function parseSessionPaneDescriptors(lines: readonly string[]): SessionPaneDescriptor[] {
  return parseSessionPaneDescriptorReply(lines).descriptors;
}

function parseSessionPaneDescriptorReply(
  lines: readonly string[],
): ParsedSessionPaneDescriptorReply {
  const descriptors: SessionPaneDescriptor[] = [];
  let malformedUtf8Records = 0;
  for (const line of lines) {
    const utf8Line = decodeControlReplyUtf8(line);
    if (utf8Line === null) {
      malformedUtf8Records += 1;
      continue;
    }
    const encoded = utf8Line.split("\t");
    if (encoded.length !== 10) continue;
    const [
      runtimePaneId = "",
      semanticPaneId = "",
      role = "",
      type = "",
      currentCommand = "",
      cwd = "",
      windowIndexRaw = "",
      windowName = "",
      windowId = "",
      title = "",
    ] = encoded.map(decodeTmuxArgument);
    if (!/^%[0-9]+$/u.test(runtimePaneId)) continue;
    const parsedWindowIndex = Number(windowIndexRaw);
    const windowIndex =
      Number.isSafeInteger(parsedWindowIndex) && parsedWindowIndex >= 0 ? parsedWindowIndex : null;
    descriptors.push({
      runtimePaneId,
      semanticPaneId: nonempty(semanticPaneId),
      role: nonempty(role),
      type: nonempty(type),
      currentCommand: nonempty(currentCommand),
      cwd: nonempty(cwd),
      title: nonempty(title),
      windowIndex,
      windowName: nonempty(windowName),
      windowId: /^@[0-9]+$/u.test(windowId) ? windowId : null,
    });
  }
  return { descriptors, malformedUtf8Records };
}

export interface SessionDescriptorDiscoveryDiagnostic {
  status: "partial" | "retrying" | "failed";
  /** Any non-null discovery diagnostic means descriptor truth is degraded. */
  degraded: true;
  attempt: number;
  maxAttempts: number;
  retryInMs: number | null;
  message: string;
}

export interface SessionDescriptorDiscoveryOptions {
  query: () => Promise<string[]>;
  onDescriptors: (
    descriptors: readonly SessionPaneDescriptor[],
    listedRuntimePaneIds: ReadonlySet<string>,
  ) => void;
  onStatus?: (status: SessionDescriptorDiscoveryDiagnostic | null) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Bounded, epoch-safe descriptor query/retry coordinator. */
export class SessionDescriptorDiscovery {
  private readonly options: Required<
    Pick<SessionDescriptorDiscoveryOptions, "maxAttempts" | "baseDelayMs" | "schedule">
  > &
    Omit<SessionDescriptorDiscoveryOptions, "maxAttempts" | "baseDelayMs" | "schedule">;
  private epoch = 0;
  private cancelScheduled: (() => void) | null = null;
  private disposed = false;

  constructor(options: SessionDescriptorDiscoveryOptions) {
    this.options = {
      ...options,
      maxAttempts: positiveInteger(options.maxAttempts, 3),
      baseDelayMs: positiveInteger(options.baseDelayMs, 50),
      schedule:
        options.schedule ??
        ((callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        }),
    };
  }

  discover(listedRuntimePaneIds: ReadonlySet<string>): void {
    if (this.disposed) return;
    this.invalidatePending();
    const epoch = this.epoch;
    this.attempt(epoch, new Set(listedRuntimePaneIds), 1);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.invalidatePending();
    this.options.onStatus?.(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidatePending();
    this.disposed = true;
  }

  private invalidatePending(): void {
    this.epoch += 1;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  private attempt(epoch: number, listed: ReadonlySet<string>, attempt: number): void {
    void this.options
      .query()
      .then((lines) => {
        if (!this.isCurrent(epoch)) return;
        const parsed = parseSessionPaneDescriptorReply(lines);
        const descriptorByRuntimePane = new Map(
          parsed.descriptors
            .filter((descriptor) => listed.has(descriptor.runtimePaneId))
            .map((descriptor) => [descriptor.runtimePaneId, descriptor]),
        );
        const descriptors = [...descriptorByRuntimePane.values()];
        if (listed.size > 0 && descriptors.length === 0) {
          const malformedDetail =
            parsed.malformedUtf8Records > 0
              ? `; ${parsed.malformedUtf8Records} malformed UTF-8 record${parsed.malformedUtf8Records === 1 ? " was" : "s were"} omitted`
              : "";
          throw new Error(
            `descriptor reply covered 0 of ${listed.size} live panes${malformedDetail}`,
          );
        }
        if (descriptors.length !== listed.size || parsed.malformedUtf8Records > 0) {
          const malformedDetail =
            parsed.malformedUtf8Records > 0
              ? `; omitted ${parsed.malformedUtf8Records} malformed UTF-8 record${parsed.malformedUtf8Records === 1 ? "" : "s"}`
              : "";
          this.options.onStatus?.({
            status: "partial",
            degraded: true,
            attempt,
            maxAttempts: this.options.maxAttempts,
            retryInMs: null,
            message: `Pane descriptor discovery published ${descriptors.length} of ${listed.size} live panes${malformedDetail}.`,
          });
        } else {
          this.options.onStatus?.(null);
        }
        this.options.onDescriptors(descriptors, listed);
      })
      .catch((cause: unknown) => {
        if (!this.isCurrent(epoch)) return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (attempt >= this.options.maxAttempts) {
          this.options.onStatus?.({
            status: "failed",
            degraded: true,
            attempt,
            maxAttempts: this.options.maxAttempts,
            retryInMs: null,
            message: `Pane descriptor discovery failed after ${attempt} attempts: ${detail}`,
          });
          return;
        }
        const retryInMs = this.options.baseDelayMs * 2 ** (attempt - 1);
        this.options.onStatus?.({
          status: "retrying",
          degraded: true,
          attempt,
          maxAttempts: this.options.maxAttempts,
          retryInMs,
          message: `Pane descriptor discovery attempt ${attempt} failed: ${detail}`,
        });
        this.cancelScheduled = this.options.schedule(() => {
          this.cancelScheduled = null;
          if (this.isCurrent(epoch)) this.attempt(epoch, listed, attempt + 1);
        }, retryInMs);
      });
  }

  private isCurrent(epoch: number): boolean {
    return !this.disposed && epoch === this.epoch;
  }
}

function nonempty(value: string): string | null {
  return value.length > 0 ? value : null;
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeControlReplyUtf8(value: string): string | null {
  try {
    return STRICT_UTF8_DECODER.decode(Buffer.from(value, "latin1"));
  } catch {
    return null;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
