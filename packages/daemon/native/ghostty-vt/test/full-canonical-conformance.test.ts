import { resolve } from "node:path";
import { TerminalReplicaSnapshotSchemaZ } from "@tmux-ide/contracts";
import {
  TERMINAL_CONFORMANCE_FIXTURES,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "@tmux-ide/core";
import { describe, expect, it } from "vitest";
import { XtermTerminalInterpreterBackend } from "../../../src/terminal/session-runtime/xterm-terminal-interpreter-backend.ts";
import { loadGhosttyVtProof } from "../load.mjs";
import { applyNativeProjection } from "../normalize.mjs";

const addonPath = resolve(
  process.env.TMUX_IDE_GHOSTTY_PROOF_ADDON ??
    new URL("../build/ghostty_vt_proof.node", import.meta.url).pathname,
);
const loaded = loadGhosttyVtProof(addonPath);
if (loaded.status !== "loaded") throw new Error(loaded.error);

describe("pinned Ghostty canonical projection", () => {
  for (const fixture of TERMINAL_CONFORMANCE_FIXTURES) {
    it(`${fixture.id} parses strictly and hashes identically to xterm`, async () => {
      const native = new loaded.binding.GhosttyVtProofTerminal(fixture.cols, fixture.rows, 5000);
      const xterm = new XtermTerminalInterpreterBackend({
        cols: fixture.cols,
        rows: fixture.rows,
        scrollback: 5000,
      });
      try {
        for (const write of fixture.writes) {
          native.write(new TextEncoder().encode(write));
          await xterm.write(write);
        }
        const blank = blankTerminalReplicaSnapshot(fixture.cols, fixture.rows);
        const nativeSnapshot = TerminalReplicaSnapshotSchemaZ.parse(
          applyNativeProjection(null, native.project()),
        );
        const xtermProjection = xterm.project(blank);
        const xtermSnapshot = TerminalReplicaSnapshotSchemaZ.parse({
          cols: xtermProjection.cols,
          rows: xtermProjection.rows,
          grid: xtermProjection.grid,
          history: xtermProjection.history,
          cursor: xtermProjection.cursor,
          modes: xtermProjection.modes,
          placements: [],
          bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
        });
        expect(hashTerminalReplicaSnapshot(nativeSnapshot)).toBe(
          hashTerminalReplicaSnapshot(xtermSnapshot),
        );
      } finally {
        native.dispose();
        xterm.dispose();
      }
    });
  }
});
