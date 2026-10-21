import { createHostedPublicationMailbox } from "./hosted-publication-mailbox.ts";
import { EventEmitter } from "node:events";
import { PassThrough, Writable, type Readable } from "node:stream";
import { createHostedLiveSession } from "./hosted-live-session.ts";
import type { HostedLiveOptions } from "./hosted-live-types.ts";
import { MAX_INPUT_LINE } from "./input.ts";

/** Common lifecycle/control surface for an owned process or in-process session. */
export interface PreviewSession extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}
/** Only small commands/history receipts use byte streams. Terminal/image output stays typed. */
export class HostedPreviewSession extends EventEmitter implements PreviewSession {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  private session: ReturnType<typeof createHostedLiveSession>;
  constructor(options: Omit<HostedLiveOptions, "emit" | "diagnostic" | "drain" | "close">) {
    super();
    let pending = "";
    this.stdin = new Writable({
      highWaterMark: MAX_INPUT_LINE,
      write: (chunk, _encoding, done) => {
        const accept = async () => {
          pending += chunk.toString();
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            if (end > MAX_INPUT_LINE) throw Error("Hosted command too large");
            const command = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            await this.session.admit(command);
          }
          if (Buffer.byteLength(pending) > MAX_INPUT_LINE) throw Error("Hosted command too large");
        };
        void accept().then(
          () => done(),
          (error) => {
            void this.session.dispose();
            done(error);
          },
        );
      },
      final: (done) => {
        void this.session.end().then(() => done(), done);
      },
    });
    let publicationFailed = false;
    const mailbox = createHostedPublicationMailbox({
      deliver: (event) => {
        if ("kind" in event && event.kind === "history-handoff")
          this.stdout.write(JSON.stringify(event) + "\n");
        else this.emit("publication", event);
      },
      failed: () => {
        publicationFailed = true;
        void this.session.dispose();
      },
    });
    this.session = createHostedLiveSession({
      ...options,
      emit: mailbox.emit,
      drain: mailbox.drain,
      close: mailbox.close,
      diagnostic: (line) => {
        this.stderr.write(line);
      },
    });
    void this.session.done.then(() => {
      this.exitCode = this.session.failed || publicationFailed ? 1 : 0;
      this.stdin.destroy();
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.exitCode, null);
      this.emit("close", this.exitCode, null);
    });
  }
  kill(_signal?: NodeJS.Signals | number) {
    void this.session.dispose();
    return true;
  }
}
