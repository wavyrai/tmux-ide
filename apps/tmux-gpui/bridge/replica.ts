import type {
  TerminalDeliveryNegotiated,
  TerminalDeliveryServerMessage,
  TerminalDeliveryAck,
  TerminalReplicaSnapshot,
} from "../../../packages/contracts/src/index.ts";
import {
  createTerminalDeliveryClientState,
  admitTerminalDeliveryEnvelope,
  admitTerminalDeliveryChunk,
  TerminalDeliveryAssembler,
  completeTerminalDelivery,
  commitTerminalDelivery,
} from "../../../packages/core/src/terminal-delivery.ts";

/** One connection lifetime. Reconnection requires a new receiver, never a reused baseline. */
export function createReplica(
  negotiated: TerminalDeliveryNegotiated,
  workspace: string,
  pane: string,
  publish: (snapshot: TerminalReplicaSnapshot | null, lifetime: string | null) => void,
  ack: (ack: TerminalDeliveryAck) => void,
) {
  let state = createTerminalDeliveryClientState(negotiated, workspace, pane);
  let assembler: TerminalDeliveryAssembler | null = null;
  let retired = false;
  return {
    retire() {
      retired = true;
      assembler = null;
      publish(null, null);
    },
    accept(message: TerminalDeliveryServerMessage) {
      if (retired) return;
      try {
        if (message.type === "terminal.delivery.fault")
          throw new Error("Terminal source unavailable");
        if (message.type === "terminal.delivery") {
          state = admitTerminalDeliveryEnvelope(state, message);
          if (state.failed) throw new Error("Terminal delivery identity or ordering mismatch");
          assembler = new TerminalDeliveryAssembler(message);
          return;
        }
        state = admitTerminalDeliveryChunk(state, message);
        if (state.failed || !assembler) throw new Error("Invalid terminal chunk");
        assembler.write(message);
        if (state.nextChunk !== assembler.envelope.chunkCount) return;
        const committed = commitTerminalDelivery(state, completeTerminalDelivery(state, assembler));
        state = committed.state;
        assembler = null;
        publish(
          state.canonicalSnapshot,
          JSON.stringify([negotiated.generation, state.incarnation]),
        );
        // ACK means committed to this retained replica, not painted by the GPU.
        ack(committed.ack);
      } catch (error) {
        retired = true;
        assembler = null;
        publish(null, null);
        throw error;
      }
    },
  };
}
