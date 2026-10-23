// Run from the repository root with Node --import tsx. Shared TS/Rust wire oracle.
import { readFileSync, writeFileSync } from "node:fs";
import {
  decodeCompactSemanticTerminalUpdate,
  encodeBinarySemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
} from "../../../packages/core/src/terminal-delivery.ts";
const directory = new URL(
  "../upstream/crates/herdr-client/src/tmux_delivery/tests/",
  import.meta.url,
);
const vectors = JSON.parse(readFileSync(new URL("vectors.json", directory), "utf8"));
const binary = vectors.map((vector) => {
  const bytes = encodeBinarySemanticTerminalUpdate(
    decodeCompactSemanticTerminalUpdate(new TextEncoder().encode(vector.wire)),
  );
  return {
    ...vector,
    bytes: [...bytes],
    representationHash: hashTerminalDeliveryRepresentation(bytes),
  };
});
writeFileSync(new URL("binary-vectors.json", directory), JSON.stringify(binary, null, 2) + "\n");
