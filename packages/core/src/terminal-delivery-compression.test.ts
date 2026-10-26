import { expect, it } from "vitest";
import { TerminalDeliveryOfferSchemaZ } from "@tmux-ide/contracts";
import { negotiateTerminalDelivery } from "./terminal-delivery.ts";
it.each([113, 114])(
  "compression bundle %s keeps projection and the eight-capability limit",
  (version) => {
    const offer = TerminalDeliveryOfferSchemaZ.parse({
      protocolVersions: [1, 101, version, 102, 103, 104, 105, 106],
      encodings: ["semantic-compact-v1"],
      richPlacements: true,
    });
    expect(negotiateTerminalDelivery(offer, "generation", "nonce")).toMatchObject({
      accepted: true,
      negotiated: {
        encoding: "semantic-binary-v1",
        alternateScreenProjection: "deferred-history-v1",
      },
    });
    // An older daemon ignores an unknown bundle; the baseline offer remains valid.
    const older = {
      ...offer,
      protocolVersions: offer.protocolVersions.filter((v) => v !== version),
    };
    expect(negotiateTerminalDelivery(older, "generation", "nonce")).toMatchObject({
      accepted: true,
      negotiated: { encoding: "semantic-compact-v1" },
    });
  },
);
