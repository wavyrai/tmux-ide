import { NATIVE_JOURNAL_COVERAGE } from "@tmux-ide/contracts";
import { expect, it } from "vitest";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import {
  createNativeSplitCapabilityProbe,
  createNativeSplitReadiness,
} from "./native-split-capability.ts";

const epoch = "11111111-1111-4111-8111-111111111111";
const journal = {
  schemaVersion: 2,
  type: "capability",
  serverEpoch: epoch,
  journalEpoch: epoch,
  enabled: true,
  degraded: 0,
  capacity: 4096,
  maxBatch: 256,
  maxWaiters: 4,
  waitingReaders: 0,
  coverage: NATIVE_JOURNAL_COVERAGE,
  ownedOperationTransport: "direct-wrapper-v1",
  ownedOperationEpochGuard: "server-epoch-v1",
  ownedOperationPaneGuard: "direct-pane-v1",
  ownedOperationSessionGuard: "direct-session-v1",
};
const observer = () => ({
  nativeServerEpoch: epoch,
  ownedOperationTransport: true,
  ownedOperationEpochGuard: true,
  ownedOperationPaneGuard: true,
  ownedOperationSessionGuard: true,
});
const split = JSON.stringify({
  schemaVersion: 1,
  capability: "split-resize-v1",
  sessionMembership: "exact-session-link-v1",
  maxDepth: 64,
  maxLeaves: 512,
  maxGrid: 4096,
});

it("requires actual split support despite positive native observation, and never caches success", async () => {
  const observation = observer();
  let reply = "unknown command: tmux-ide-resize-split";
  const commands: string[][] = [];
  const probe = createNativeSplitCapabilityProbe({
    observation: () => observation,
    runPinnedTmux: (args) => {
      commands.push([...args]);
      expect(args[1]).toBe("-V");
      return args[0] === "tmux-ide-events" ? JSON.stringify(journal) : reply;
    },
  });
  expect(await probe(epoch)).toBe(false);
  reply = split;
  expect(await probe(epoch)).toBe(true);
  reply = JSON.stringify({ ...JSON.parse(split), sessionMembership: "unknown" });
  expect(await probe(epoch)).toBe(false);
  expect(commands.filter((args) => args[0] === "tmux-ide-resize-split")).toEqual(
    Array(3).fill(["tmux-ide-resize-split", "-V"]),
  );
});

it.each(["native-before", "native-after", "observation", "oversized", "throw"])(
  "refuses changed or unproven server identity: %s",
  async (scenario) => {
    let observation = observer();
    let epochReads = 0;
    let splitReads = 0;
    const probe = createNativeSplitCapabilityProbe({
      observation: () => observation,
      runPinnedTmux: async (args) => {
        if (args[0] === "tmux-ide-resize-split") {
          splitReads++;
          if (scenario === "observation") observation = observer();
          if (scenario === "throw") throw new Error("private error");
          if (scenario === "oversized") return " ".repeat(1025) + split;
          return split;
        }
        epochReads++;
        return JSON.stringify({
          ...journal,
          serverEpoch:
            scenario === "native-before" || (scenario === "native-after" && epochReads === 2)
              ? "replaced"
              : epoch,
        });
      },
    });
    expect(await probe(epoch)).toBe(false);
    expect(splitReads).toBe(scenario === "native-before" ? 0 : 1);
    expect(epochReads).toBe(scenario === "native-after" ? 2 : 1);
  },
);

it.each(["disabled", "degraded", "wrapper", "pane", "session", "schema", "observer"])(
  "refuses missing readiness: %s",
  async (scenario) => {
    const observation = observer();
    const capability: Record<string, unknown> = { ...journal };
    if (scenario === "disabled") capability.enabled = false;
    if (scenario === "degraded") capability.degraded = 1;
    if (scenario === "wrapper") delete capability.ownedOperationTransport;
    if (scenario === "pane") delete capability.ownedOperationPaneGuard;
    if (scenario === "session") delete capability.ownedOperationSessionGuard;
    if (scenario === "schema") delete capability.coverage;
    if (scenario === "observer") observation.ownedOperationSessionGuard = false;
    const probe = createNativeSplitCapabilityProbe({
      observation: () => observation,
      runPinnedTmux: (args) => (args[0] === "tmux-ide-events" ? JSON.stringify(capability) : split),
    });
    expect(await probe(epoch)).toBe(false);
  },
);

it.each(["supported", "unsupported", "replaced", "epoch"])(
  "lazy preflight never enables an unproven owner: %s",
  async (scenario) => {
    let activations = 0;
    let splitProbes = 0;
    let epochReads = 0;
    const ready = Promise.withResolvers<boolean>();
    let observation = {
      nativeServerEpoch: null,
      activateForSplit: async (captured: string) => {
        expect(captured).toBe(epoch);
        activations++;
        return ready.promise;
      },
    } as unknown as OwnerInteractionObservation;
    const prepare = createNativeSplitReadiness({
      observation: () => observation,
      runPinnedTmux: async (args) => {
        expect(args[1]).toBe("-V");
        if (args[0] === "tmux-ide-resize-split") {
          splitProbes++;
          if (scenario === "replaced")
            observation = { ...observation } as OwnerInteractionObservation;
          return scenario === "unsupported" ? "unknown command" : split;
        }
        epochReads++;
        return JSON.stringify({
          ...journal,
          enabled: false,
          serverEpoch:
            scenario === "epoch" && epochReads === 2
              ? "22222222-2222-4222-8222-222222222222"
              : epoch,
        });
      },
    });
    const first = prepare();
    const second = prepare();
    expect(second).toBe(first);
    ready.resolve(true);
    expect(await first).toBe(scenario === "supported");
    expect(activations).toBe(scenario === "supported" ? 1 : 0);
    expect(splitProbes).toBe(1);
  },
);
