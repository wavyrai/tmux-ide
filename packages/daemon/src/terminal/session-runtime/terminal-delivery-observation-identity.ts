import type { TerminalDeliveryEnvelope } from "@tmux-ide/contracts";

const deliveryOrdinals = new WeakMap<TerminalDeliveryEnvelope, number>();

export function registerTerminalDeliveryObservationOrdinal(
  envelope: TerminalDeliveryEnvelope,
  ordinal: number,
): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1)
    throw new TypeError("terminal delivery observation ordinal was invalid");
  deliveryOrdinals.set(envelope, ordinal);
}

export function terminalDeliveryObservationOrdinal(
  envelope: TerminalDeliveryEnvelope,
): number | null {
  return deliveryOrdinals.get(envelope) ?? null;
}
