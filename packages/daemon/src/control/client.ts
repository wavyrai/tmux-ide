/**
 * A minimal control-socket client — what the CLI's `--socket` fast-paths
 * (`events --follow --socket`, `wait … --socket`) ride on. Connect, send
 * id-correlated requests, optionally receive pushed event frames. Kept
 * dependency-light on purpose: this is also the reference for "how would an
 * agent drive the socket from node" (see skill/SKILL.md).
 */
import { connect, type Socket } from "node:net";
import {
  CONTROL_PROTOCOL_VERSION,
  controlEventSchema,
  controlResponseSchema,
  type ControlEventFrame,
} from "@tmux-ide/contracts";
import { createFrameSplitter, encodeFrame } from "./frames.ts";
import { defaultControlSocketPath } from "./server.ts";

/** A failed verb, carrying the server's machine-readable error code. */
export class ControlRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ControlClient {
  /** Send one verb; resolves with the response `data`, rejects with
   *  {@link ControlRequestError} on an error response or a dropped socket. */
  request(verb: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Receive pushed event frames (also sends the `subscribe` verb). */
  subscribe(onEvent: (event: ControlEventFrame) => void): Promise<void>;
  close(): void;
  /** Resolves when the connection ends (server shutdown → EOF). */
  done: Promise<void>;
}

/**
 * Connect to a control server. Rejects (quickly) when nothing is listening —
 * callers treat that as "no server, fall back to polling".
 */
export function connectControl(opts: { socketPath?: string } = {}): Promise<ControlClient> {
  const path = opts.socketPath ?? defaultControlSocketPath();
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(wrap(socket));
    });
  });
}

function wrap(socket: Socket): ControlClient {
  socket.setEncoding("utf8");
  const split = createFrameSplitter();
  const pending = new Map<
    string | number,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  const eventSinks: Array<(event: ControlEventFrame) => void> = [];
  let nextId = 1;

  let markDone: () => void;
  const done = new Promise<void>((r) => {
    markDone = r;
  });

  socket.on("data", (chunk: string) => {
    for (const line of split(chunk)) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue; // a malformed server frame — skip, ids keep us honest
      }
      const event = controlEventSchema.safeParse(raw);
      if (event.success) {
        for (const sink of eventSinks) sink(event.data);
        continue;
      }
      const response = controlResponseSchema.safeParse(raw);
      if (!response.success || response.data.id === null) continue;
      const waiter = pending.get(response.data.id);
      if (!waiter) continue;
      pending.delete(response.data.id);
      if (response.data.ok) waiter.resolve(response.data.data);
      else {
        waiter.reject(
          new ControlRequestError(response.data.error.code, response.data.error.message),
        );
      }
    }
  });
  const teardown = (): void => {
    for (const { reject } of pending.values()) {
      reject(new ControlRequestError("disconnected", "control socket closed"));
    }
    pending.clear();
    markDone();
  };
  socket.on("close", teardown);
  socket.on("error", () => {
    // 'close' follows and runs the teardown
  });

  const request = (verb: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new ControlRequestError("disconnected", "control socket closed"));
        return;
      }
      pending.set(id, { resolve, reject });
      socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, verb, params }));
    });
  };

  return {
    request,
    subscribe: async (onEvent) => {
      eventSinks.push(onEvent);
      await request("subscribe");
    },
    close: () => socket.destroy(),
    done,
  };
}
