import type { TerminalDeliveryEnvelope, TerminalProjectionEnvelope } from "@tmux-ide/contracts";

const deliveryOrdinals = new WeakMap<
  TerminalDeliveryEnvelope | TerminalProjectionEnvelope,
  number
>();

export function registerTerminalDeliveryObservationOrdinal(
  envelope: TerminalDeliveryEnvelope | TerminalProjectionEnvelope,
  ordinal: number,
): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1)
    throw new TypeError("terminal delivery observation ordinal was invalid");
  deliveryOrdinals.set(envelope, ordinal);
}

export function terminalDeliveryObservationOrdinal(
  envelope: TerminalDeliveryEnvelope | TerminalProjectionEnvelope,
): number | null {
  return deliveryOrdinals.get(envelope) ?? null;
}
