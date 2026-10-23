import { expect, it } from "vitest";
import {
  encodeTerminalDeliveryBinaryChunk,
  decodeTerminalDeliveryBinaryChunk,
} from "./terminal-delivery-binary-chunk.ts";
const header = { pane: "pane-a", transactionId: "00000000-0000-4000-8000-000000000001", index: 0 };
it("roundtrips raw bytes including zero and nonUTF8 without base64", () => {
  for (const bytes of [
    new Uint8Array(),
    Uint8Array.from([0, 128, 255]),
    new Uint8Array(256 * 1024),
  ])
    expect(
      decodeTerminalDeliveryBinaryChunk(encodeTerminalDeliveryBinaryChunk(header, bytes)),
    ).toEqual({ header, bytes });
});
it("rejects malformed metadata, lengths, magic and UTF8", () => {
  const packet = encodeTerminalDeliveryBinaryChunk(header, Uint8Array.of(1));
  for (const change of [
    (p: Uint8Array) => {
      p[0] = 0;
    },
    (p: Uint8Array) => {
      p[4] = 255;
    },
    (p: Uint8Array) => {
      p[8] = 255;
    },
  ]) {
    const p = packet.slice();
    change(p);
    expect(() => decodeTerminalDeliveryBinaryChunk(p)).toThrow();
  }
  for (let size = 0; size < packet.length - 1; size++)
    expect(() => decodeTerminalDeliveryBinaryChunk(packet.subarray(0, size))).toThrow();
  expect(() =>
    encodeTerminalDeliveryBinaryChunk({ ...header, index: 256 }, new Uint8Array()),
  ).toThrow();
  expect(() =>
    encodeTerminalDeliveryBinaryChunk({ ...header, extra: 1 } as typeof header, new Uint8Array()),
  ).toThrow();
  expect(() => encodeTerminalDeliveryBinaryChunk(header, new Uint8Array(256 * 1024 + 1))).toThrow();
});
