import { describe, expect, it } from "vitest";
import type { PtyAdapter, PtyProcess, PtySpawnInput, PtySpawnListeners } from "../PtyAdapter.ts";
import {
  PtyTmuxAttachmentInputUnavailableError,
  PtyTmuxAttachmentLauncher,
} from "../attachments/pty-tmux-attachment-launcher.ts";
import {
  planGroupedTmuxAttachment,
  type GroupedTmuxAttachmentPlan,
} from "../attachments/grouped-tmux.ts";
import type {
  TmuxAttachmentClientTransportInput,
  TmuxAttachmentCommandRunner,
} from "../attachments/tmux-view-executor.ts";
import { MockPtyAdapter, MockPtyProcess } from "./MockPtyAdapter.ts";

const FIRST_ID = "90becb1c-632c-486a-a7f9-3f351874e4af";
const SECOND_ID = "af9d2102-0721-4a99-8798-79a072ae38f6";

function plan(
  attachmentId = FIRST_ID,
  generation = 0,
  viewerMode: GroupedTmuxAttachmentPlan["viewerMode"] = "interactive",
) {
  return planGroupedTmuxAttachment({
    attachmentId,
    generation,
    target: { workspaceName: "workspace.alpha", semanticPaneId: "pane.worker" },
    viewerMode,
    viewport: { cols: 120, rows: 40 },
    source: { sessionId: "$12", windowId: "@34", runtimePaneId: "%56", paneCount: 1 },
  });
}

function input(selectedPlan = plan()): TmuxAttachmentClientTransportInput {
  return {
    command: {
      executable: "tmux",
      argv: ["if-shell", "-F", "-t", "$12:@34.%56", "trusted-proof", "attach"],
    },
    identity: {
      attachmentId: selectedPlan.identity.attachmentId,
      generation: selectedPlan.identity.generation,
      viewSessionName: selectedPlan.identity.viewSessionName,
      markerValue: selectedPlan.identity.markerValue,
      expectedWindowId: selectedPlan.identity.durableSource.windowId,
      expectedPaneId: selectedPlan.identity.durableSource.runtimePaneId,
    },
    viewport: { ...selectedPlan.viewport },
    viewerMode: selectedPlan.viewerMode,
  };
}

class ProofRunner implements TmuxAttachmentCommandRunner {
  readonly calls: string[][] = [];
  response: () => ReturnType<TmuxAttachmentCommandRunner["run"]> = () => ({
    status: "ok",
    stdout: "",
  });

  run(command: Parameters<TmuxAttachmentCommandRunner["run"]>[0]) {
    this.calls.push([...command.argv]);
    return this.response();
  }
}

function launcher(
  adapter: PtyAdapter,
  proofRunner: ProofRunner,
  overrides: Partial<ConstructorParameters<typeof PtyTmuxAttachmentLauncher>[0]> = {},
) {
  return new PtyTmuxAttachmentLauncher({
    socketSelector: { kind: "name", name: "owned-socket" },
    trustedCwd: "/daemon/project",
    tmuxExecutable: "/trusted/bin/tmux",
    ptyAdapter: adapter,
    proofRunner,
    environment: {
      PATH: "/hostile/bin",
      TERM: "screen-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TMUX: "/tmp/foreign,1,2",
      TMUX_PANE: "%999",
      SECRET_TOKEN: "must-not-cross",
      BAD_LOCALE: "x",
    },
    ...overrides,
  });
}

function proveCurrentAttached(
  proofRunner: ProofRunner,
  adapter: MockPtyAdapter,
  selectedPlan: GroupedTmuxAttachmentPlan,
): void {
  proofRunner.response = () => ({
    status: "ok",
    stdout: `${adapter.lastSpawned()!.pid}\t${selectedPlan.identity.viewSessionName}\n`,
  });
}

describe("PtyTmuxAttachmentLauncher", () => {
  it("rejects arbitrary commands before a PTY can spawn", () => {
    const adapter = new MockPtyAdapter();
    const proof = new ProofRunner();
    const transport = launcher(adapter, proof);
    const canonical = input();
    const hostile: TmuxAttachmentClientTransportInput = {
      ...canonical,
      command: { executable: "tmux", argv: ["run-shell", "touch /tmp/not-owned"] },
    };

    expect(() => transport.beginGuardedAttach(hostile)).toThrow(/invalid/u);
    expect(adapter.spawnCount).toBe(0);
  });

  it("synchronously spawns only daemon-owned tmux argv/cwd/env and proves the exact client", async () => {
    const adapter = new MockPtyAdapter();
    const proof = new ProofRunner();
    const selectedPlan = plan();
    proveCurrentAttached(proof, adapter, selectedPlan);
    const transport = launcher(adapter, proof);

    const attempt = transport.beginGuardedAttach(input(selectedPlan));

    expect(adapter.spawnCount).toBe(1);
    expect(adapter.spawnLog[0]).toEqual({
      shell: "/trusted/bin/tmux",
      args: [
        "-L",
        "owned-socket",
        "if-shell",
        "-F",
        "-t",
        "$12:@34.%56",
        "trusted-proof",
        "attach",
      ],
      cwd: "/daemon/project",
      cols: 120,
      rows: 40,
      env: {
        TERM: "screen-256color",
        COLORTERM: "truecolor",
        LANG: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
      },
      name: "screen-256color",
      encoding: null,
    });
    expect(attempt.status).toBe("claimed");
    await expect(attempt.outcome).resolves.toEqual({ status: "executed" });
    expect(adapter.lastSpawned()!.paused).toBe(true);
    expect(proof.calls[0]?.slice(0, 2)).toEqual(["-L", "owned-socket"]);
    expect(proof.calls[0]).toContainEqual(
      expect.stringContaining(`=${selectedPlan.identity.viewSessionName}`),
    );
    expect(proof.calls[0]?.join(" ")).toContain(selectedPlan.identity.markerValue);
    transport.disposeAll();
  });

  it("captures output emitted synchronously inside spawn without losing a byte", async () => {
    class SynchronousOutputAdapter extends MockPtyAdapter {
      override spawnSync(spawnInput: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
        const process = super.spawnSync(spawnInput, listeners) as MockPtyProcess;
        process.pushOutput(Buffer.from([0x00, 0x80, 0xff, 0x41]));
        return process;
      }
    }
    const adapter = new SynchronousOutputAdapter();
    const proof = new ProofRunner();
    const selectedPlan = plan();
    proveCurrentAttached(proof, adapter, selectedPlan);
    const transport = launcher(adapter, proof);
    const attempt = transport.beginGuardedAttach(input(selectedPlan));
    await attempt.outcome;
    const client = transport.claim(attempt)!;
    const output: Buffer[] = [];

    client.onData((data) => output.push(data));

    expect(Buffer.concat(output)).toEqual(Buffer.from([0x00, 0x80, 0xff, 0x41]));
    expect(adapter.lastSpawned()!.paused).toBe(false);
    client.dispose();
  });

  it.each([
    ["bytes", { maxEarlyOutputBytes: 3, maxEarlyOutputFrames: 4 }],
    ["frames", { maxEarlyOutputBytes: 32, maxEarlyOutputFrames: 1 }],
  ])("fails closed when synchronous early output exceeds the %s cap", async (_label, caps) => {
    class OverflowAdapter extends MockPtyAdapter {
      override spawnSync(spawnInput: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
        const process = super.spawnSync(spawnInput, listeners) as MockPtyProcess;
        process.pushOutput("abc");
        process.pushOutput("def");
        return process;
      }
    }
    const adapter = new OverflowAdapter();
    const proof = new ProofRunner();
    const transport = launcher(adapter, proof, caps);

    const attempt = transport.beginGuardedAttach(input());

    await expect(attempt.outcome).resolves.toEqual({ status: "failed" });
    expect(adapter.lastSpawned()!.killed).toBe("SIGTERM");
    expect(transport.claim(attempt)).toBeNull();
  });

  it("fails closed on synchronous exit and on a bounded readiness timeout", async () => {
    class SynchronousExitAdapter extends MockPtyAdapter {
      override spawnSync(spawnInput: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
        const process = super.spawnSync(spawnInput, listeners) as MockPtyProcess;
        process.emitExit({ exitCode: 1, signal: null });
        return process;
      }
    }
    const exitAdapter = new SynchronousExitAdapter();
    const exitProof = new ProofRunner();
    const exited = launcher(exitAdapter, exitProof).beginGuardedAttach(input());
    await expect(exited.outcome).resolves.toEqual({ status: "failed" });
    expect(exitProof.calls).toHaveLength(0);

    let now = 0;
    const scheduled: Array<() => void> = [];
    const timeoutAdapter = new MockPtyAdapter();
    const timeoutProof = new ProofRunner();
    const timeoutTransport = launcher(timeoutAdapter, timeoutProof, {
      readinessTimeoutMs: 10,
      readinessPollIntervalMs: 1,
      now: () => now,
      schedule: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
    });
    const timedOut = timeoutTransport.beginGuardedAttach(input());
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    now = 10;
    scheduled.shift()!();
    await expect(timedOut.outcome).resolves.toEqual({ status: "failed" });
    expect(timeoutAdapter.lastSpawned()!.killed).toBe("SIGTERM");
  });

  it("fails closed on proof mismatch or malformed client ownership", async () => {
    const mismatchAdapter = new MockPtyAdapter();
    const mismatchProof = new ProofRunner();
    mismatchProof.response = () => ({
      status: "ok",
      stdout: "__tmux_ide_pty_view_proof_mismatch_v1__\n",
    });
    const mismatchTransport = launcher(mismatchAdapter, mismatchProof);
    const mismatch = mismatchTransport.beginGuardedAttach(input());
    await expect(mismatch.outcome).resolves.toEqual({ status: "view-proof-mismatch" });
    expect(mismatchAdapter.lastSpawned()!.killed).toBe("SIGTERM");

    const malformedAdapter = new MockPtyAdapter();
    const malformedProof = new ProofRunner();
    malformedProof.response = () => ({
      status: "ok",
      stdout: `${malformedAdapter.lastSpawned()!.pid}\twrong-view\n`,
    });
    const malformedTransport = launcher(malformedAdapter, malformedProof);
    const malformed = malformedTransport.beginGuardedAttach(input());
    await expect(malformed.outcome).resolves.toEqual({ status: "failed" });
    expect(malformedAdapter.lastSpawned()!.killed).toBe("SIGTERM");
  });

  it("uses exact generation ownership and permits exactly one claim", async () => {
    const adapter = new MockPtyAdapter();
    const proof = new ProofRunner();
    const firstPlan = plan(FIRST_ID, 0);
    proveCurrentAttached(proof, adapter, firstPlan);
    const transport = launcher(adapter, proof);
    const first = transport.beginGuardedAttach(input(firstPlan));
    expect(transport.claim(first)).toBeNull();
    await first.outcome;
    expect(() => transport.beginGuardedAttach(input(firstPlan))).toThrow(/generation/u);
    expect(transport.claim({ ...first, attemptId: SECOND_ID })).toBeNull();
    const claimed = transport.claim(first);
    expect(claimed).not.toBeNull();
    expect(transport.claim(first)).toBeNull();

    const nextPlan = plan(FIRST_ID, 1);
    proveCurrentAttached(proof, adapter, nextPlan);
    const next = transport.beginGuardedAttach(input(nextPlan));
    expect(adapter.spawned[0]!.killed).toBe("SIGTERM");
    await expect(next.outcome).resolves.toEqual({ status: "executed" });
    expect(() => transport.beginGuardedAttach(input(firstPlan))).toThrow(/generation/u);
    transport.disposeAll();
  });

  it("releases registry capacity when a claimed PTY exits without explicit dispose", async () => {
    const adapter = new MockPtyAdapter();
    const proof = new ProofRunner();
    const firstPlan = plan(FIRST_ID);
    proveCurrentAttached(proof, adapter, firstPlan);
    const transport = launcher(adapter, proof, { maxOwnedAttempts: 1 });
    const first = transport.beginGuardedAttach(input(firstPlan));
    await first.outcome;
    const firstClient = transport.claim(first)!;
    const exitEvents: Array<{ exitCode: number; signal: number | null }> = [];
    firstClient.onExit((event) => exitEvents.push(event));
    adapter.spawned[0]!.emitExit({ exitCode: 0, signal: null });

    const secondPlan = plan(SECOND_ID);
    proveCurrentAttached(proof, adapter, secondPlan);
    const second = transport.beginGuardedAttach(input(secondPlan));

    await expect(second.outcome).resolves.toEqual({ status: "executed" });
    expect(exitEvents).toEqual([{ exitCode: 0, signal: null }]);
    expect(() => firstClient.resize(90, 30)).not.toThrow();
    transport.disposeAll();
  });

  it("keeps native input gated and rejects read-only before PTY spawn", async () => {
    const adapter = new MockPtyAdapter();
    const proof = new ProofRunner();
    const interactivePlan = plan();
    proveCurrentAttached(proof, adapter, interactivePlan);
    const transport = launcher(adapter, proof);
    const attempt = transport.beginGuardedAttach(input(interactivePlan));
    await attempt.outcome;
    const interactive = transport.claim(attempt)!;
    expect(() => interactive.write("unbounded")).toThrow(PtyTmuxAttachmentInputUnavailableError);
    expect(adapter.lastSpawned()!.writeLog).toHaveLength(0);
    interactive.resize(91, 31);
    expect(adapter.lastSpawned()!.resizeLog).toEqual([{ cols: 91, rows: 31 }]);
    interactive.dispose();

    const readOnlyPlan = plan(SECOND_ID, 0, "read-only");
    const spawnCount = adapter.spawnCount;
    expect(() => transport.beginGuardedAttach(input(readOnlyPlan))).toThrowError(
      expect.objectContaining({
        name: "TmuxAttachmentClientTransportError",
        code: "read_only_unavailable",
      }),
    );
    expect(adapter.spawnCount).toBe(spawnCount);
  });

  it("disposes only the PTY client and never emits a tmux kill-session command", async () => {
    const adapter = new MockPtyAdapter();
    const proof = new ProofRunner();
    const selectedPlan = plan();
    proveCurrentAttached(proof, adapter, selectedPlan);
    const transport = launcher(adapter, proof);
    const attempt = transport.beginGuardedAttach(input(selectedPlan));
    await attempt.outcome;
    const client = transport.claim(attempt)!;

    client.dispose();
    client.dispose();

    expect(adapter.lastSpawned()!.killed).toBe("SIGTERM");
    expect(proof.calls.flat()).not.toContain("kill-session");
  });
});
