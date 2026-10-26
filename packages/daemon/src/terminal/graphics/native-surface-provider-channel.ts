import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalSurfaceAuditTokenSchemaZ,
  TerminalSurfaceOfferSchemaZ,
  TERMINAL_SURFACE_MAX_CONTROL_BYTES,
} from "@tmux-ide/contracts";
import {
  NativeSurfaceProviderRegistry,
  type NativeSurfaceProvider,
} from "./native-surface-provider.ts";

const Register = z
  .object({
    type: z.literal("register"),
    version: z.literal(1),
    generation: z.uuid(),
    auditToken: TerminalSurfaceAuditTokenSchemaZ,
  })
  .strict();
const Offer = z
  .object({
    type: z.literal("offer"),
    connection: z.uuid(),
    offer: TerminalSurfaceOfferSchemaZ,
  })
  .strict();
const WatchDemand = z
  .object({
    type: z.literal("watch-demand"),
    panes: z.array(TerminalAttachmentSemanticPaneIdSchemaZ).min(1).max(32),
  })
  .strict();
type Context = Parameters<NativeSurfaceProvider["open"]>[0];

/** Only an authenticated owner connection may construct this channel. Kernel
 * identity proof is still mandatory at the native receiver. No payload contains
 * pixel storage, executable paths, or a reusable daemon credential. */
export class NativeSurfaceProviderChannel {
  #unregister: (() => void) | null = null;
  #connections = new Map<string, Context>();
  #closed = false;
  #stopDemand: (() => void) | null = null;
  #demandPanes: string[] | null = null;
  #lastDemand: string | null = null;
  constructor(
    readonly registry: NativeSurfaceProviderRegistry,
    readonly send: (message: string) => boolean,
    readonly disconnect: () => void,
  ) {}
  receive(text: string): void {
    if (this.#closed) return;
    if (Buffer.byteLength(text) > TERMINAL_SURFACE_MAX_CONTROL_BYTES) {
      this.close();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.close();
      return;
    }
    if (!this.#unregister) {
      const registration = Register.safeParse(value);
      if (!registration.success || registration.data.generation !== this.registry.generation) {
        this.close();
        return;
      }
      try {
        this.#unregister = this.registry.register({
          auditToken: registration.data.auditToken,
          open: (context) => this.#open(context),
        });
      } catch {
        this.close();
        return;
      }
      this.#send({ type: "registered", version: 1, generation: this.registry.generation });
      return;
    }
    const watch = WatchDemand.safeParse(value);
    if (watch.success) {
      const panes = [...new Set(watch.data.panes)].sort();
      if (this.#demandPanes) {
        if (JSON.stringify(panes) !== JSON.stringify(this.#demandPanes)) this.close();
        return;
      }
      this.#demandPanes = panes;
      try {
        this.#stopDemand = this.registry.demand.watch(() => {
          const required = panes.filter((pane) => this.registry.demand.required(pane));
          const key = JSON.stringify(required);
          if (key === this.#lastDemand) return;
          this.#lastDemand = key;
          this.#send({ type: "kitty-demand", panes, required });
        });
      } catch {
        this.close();
      }
      return;
    }
    const parsed = Offer.safeParse(value);
    if (!parsed.success) {
      this.close();
      return;
    }
    const { connection, offer } = parsed.data;
    const context = this.#connections.get(connection);
    if (!context) {
      this.close();
      return;
    }
    const accepted = context.offer(offer);
    // The producer must wait for accepted=true before transferring the matching
    // native right. A dropped channel or rejected offer grants no transfer.
    this.#send({ type: "offered", connection, sequence: offer.sequence, accepted });
  }
  #open(context: Context) {
    if (this.#closed || this.#connections.size >= 32)
      throw new Error("Native provider unavailable");
    const connection = randomUUID();
    this.#connections.set(connection, context);
    return {
      start: () => {
        this.#send({ type: "start", connection, receiver: context.receiver, panes: context.panes });
      },
      retire: (sequence: number) => {
        this.#send({ type: "retired", connection, sequence });
      },
      fallback: () => {
        this.#send({ type: "fallback", connection });
      },
      close: () => {
        this.#connections.delete(connection);
        this.#send({ type: "close", connection });
      },
    };
  }
  #send(value: unknown): void {
    if (this.#closed) return;
    const text = JSON.stringify(value);
    try {
      if (Buffer.byteLength(text) <= TERMINAL_SURFACE_MAX_CONTROL_BYTES && this.send(text)) return;
    } catch {
      /* A failed sink revokes all further native offers. */
    }
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopDemand?.();
    this.#stopDemand = null;
    this.#unregister?.();
    this.#unregister = null;
    this.#connections.clear();
    this.disconnect();
  }
}
