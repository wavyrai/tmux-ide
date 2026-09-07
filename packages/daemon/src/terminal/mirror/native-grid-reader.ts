import type { MirrorChannelIo } from "./control-channel.ts";
import { decodeNativeGridCapture, type NativeGridCapture } from "./native-grid-capture.ts";

export type NativeGridReadResult =
  | {
      readonly status: "captured";
      readonly snapshot: NativeGridCapture;
      /** Daemon-private admission guard; never serialize this as client state.
       * Check again after awaiting canonical parser work, before binding a
       * revision. Once admitted as frozen history, later output is independent.
       */
      readonly isCurrent: () => boolean;
    }
  | {
      readonly status:
        | "unsupported"
        | "unavailable"
        | "retired"
        | "changed"
        | "invalid"
        | "timeout";
    };

/** One experimental capability owner per control connection. */
export class NativeGridCaptureReader {
  private unsupported = false;
  private retired = false;
  private readonly pending = new Set<() => void>();

  constructor(private readonly io: Pick<MirrorChannelIo, "commandBoundedInline">) {}

  read(
    runtimePaneId: string,
    owns: () => boolean,
    isCurrent: () => boolean = () => true,
  ): Promise<NativeGridReadResult> {
    if (this.retired || !owns()) return Promise.resolve({ status: "retired" });
    if (!isCurrent()) return Promise.resolve({ status: "changed" });
    if (this.unsupported || !this.io.commandBoundedInline)
      return Promise.resolve({ status: "unsupported" });
    if (!/^%\d+$/.test(runtimePaneId) || this.pending.size >= 64)
      return Promise.resolve({ status: "unavailable" });
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: NativeGridReadResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.status !== "timeout") this.pending.delete(retire);
        resolve(result);
      };
      const retire = () => finish({ status: "retired" });
      this.pending.add(retire);
      timer = setTimeout(() => finish({ status: "timeout" }), 5000);
      try {
        this.io.commandBoundedInline!(
          `capture-pane -p -R -S - -t ${runtimePaneId}`,
          { maxBytes: 16 * 1024 * 1024, maxLines: 262144 },
          (reply) => {
            if (settled) {
              this.pending.delete(retire);
              return;
            }
            if (this.retired || !owns()) {
              retire();
              return;
            }
            if (!reply.ok) {
              // Cache only the server's explicit missing-option response.
              // A vanished pane, transport failure or cap overflow is retryable.
              if (
                reply.lines.some((line) =>
                  /^(?:parse error: )?command capture-pane: unknown flag -R$/.test(line),
                )
              ) {
                this.unsupported = true;
                finish({ status: "unsupported" });
              } else finish({ status: "unavailable" });
              return;
            }
            if (!isCurrent()) {
              finish({ status: "changed" });
              return;
            }
            const snapshot = decodeNativeGridCapture(reply.lines.join("\n"));
            finish(
              snapshot
                ? {
                    status: "captured",
                    snapshot,
                    isCurrent: () => !this.retired && owns() && isCurrent(),
                  }
                : { status: "invalid" },
            );
          },
        );
      } catch {
        finish({ status: "unavailable" });
      }
    });
  }

  dispose(): void {
    this.retired = true;
    for (const retire of [...this.pending]) retire();
    this.pending.clear();
  }
}
