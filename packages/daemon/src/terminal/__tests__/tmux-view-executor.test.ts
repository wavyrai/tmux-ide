import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
  planGroupedTmuxAttachment,
  type GroupedTmuxAttachmentPlan,
  type TmuxArgvPlan,
} from "../attachments/grouped-tmux.ts";
import type {
  GuardedAttachmentCleanup,
  GuardedAttachmentViewOperation,
} from "../attachments/lease-manager.ts";
import {
  TmuxAttachmentClientTransportError,
  TmuxAttachmentOperationSerializer,
  TmuxAttachmentViewExecutor,
  TmuxAttachmentViewExecutorError,
  planCanonicalTmuxAttachmentClientCommand,
  type TmuxAttachmentClientTransportInput,
  type TmuxAttachmentClientTransportOutcome,
  type TmuxAttachmentCommandResult,
  type TmuxAttachmentCommandRunner,
} from "../attachments/tmux-view-executor.ts";

const attachmentId = "f3d8bc0b-460c-458c-b9c0-dbc2536d1486";
const secondAttachmentId = "a45072f8-5a82-4930-8bed-0959c617e60b";

interface FakeView {
  marker: string | null;
  windows: string[];
}

class FakeRunner implements TmuxAttachmentCommandRunner {
  readonly calls: string[][] = [];
  readonly views = new Map<string, FakeView>();
  readonly sessionIds = new Map<string, string>();
  sourceOutput = "$12\t@34\t%56\t1\n";
  sessionsOutput: string | null = null;
  rawOutput: ((argv: readonly string[]) => string | null) | undefined;
  fail: ((argv: readonly string[]) => "not-found" | "failed" | "throw" | null) | undefined;
  before: ((argv: readonly string[]) => void) | undefined;
  partialCreateFailure = false;
  mutationCount = 0;
  serverSourceGuardMatches = true;
  serverViewGuardMatches = true;

  sessionId(name: string): string {
    const existing = this.sessionIds.get(name);
    if (existing) return existing;
    const allocated = `$${90 + this.sessionIds.size}`;
    this.sessionIds.set(name, allocated);
    return allocated;
  }

  #parseCommandString(value: string): string[][] {
    const commands: string[][] = [[]];
    let offset = 0;
    while (offset < value.length) {
      while (value[offset] === " ") offset += 1;
      if (offset >= value.length) break;
      if (value[offset] === ";") {
        commands.push([]);
        offset += 1;
        continue;
      }
      if (value[offset] !== '"') throw new Error("invalid fake command string");
      let end = offset + 1;
      let escaped = false;
      for (; end < value.length; end += 1) {
        const character = value[end]!;
        if (!escaped && character === '"') break;
        if (!escaped && character === "\\") escaped = true;
        else escaped = false;
      }
      if (end >= value.length) throw new Error("unterminated fake command string");
      commands.at(-1)!.push(JSON.parse(value.slice(offset, end + 1)) as string);
      offset = end + 1;
    }
    return commands.filter((command) => command.length > 0);
  }

  #runCommandString(value: string): TmuxAttachmentCommandResult {
    const commands = this.#parseCommandString(value);
    const creation = commands.find((command) => command[0] === "new-session");
    if (creation) {
      for (const command of commands) this.calls.push(command);
      const name = creation[creation.indexOf("-s") + 1]!;
      const markerCommand = commands.find(
        (command) =>
          command[0] === "set-environment" &&
          command.includes(GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT),
      );
      const markerIndex = markerCommand?.indexOf(GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT) ?? -1;
      const link = commands.find((command) => command[0] === "link-window");
      const source = link?.[link.indexOf("-s") + 1] ?? "";
      this.views.set(name, {
        marker: markerCommand?.[markerIndex + 1] ?? null,
        windows: [source.slice(source.indexOf(":") + 1)],
      });
      this.sessionId(name);
      this.mutationCount += 1;
      return this.partialCreateFailure ? { status: "failed" } : { status: "ok", stdout: "" };
    }
    let result: TmuxAttachmentCommandResult = { status: "ok", stdout: "" };
    for (const command of commands) {
      result = this.run({ executable: "tmux", argv: command });
      if (result.status !== "ok") return result;
    }
    return result;
  }

  run(command: TmuxArgvPlan): TmuxAttachmentCommandResult {
    const argv = [...command.argv];
    this.calls.push(argv);
    this.before?.(argv);
    const raw = this.rawOutput?.(argv);
    if (raw !== undefined && raw !== null) return { status: "ok", stdout: raw };
    const requestedFailure = this.fail?.(argv);
    if (requestedFailure === "throw") {
      throw new Error("raw-secret-%999-$888-@777");
    }
    if (requestedFailure) return { status: requestedFailure };

    switch (argv[0]) {
      case "if-shell": {
        const target = argv[argv.indexOf("-t") + 1] ?? "";
        const isViewGuard =
          target.startsWith("=") || argv[4]?.includes(GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT);
        const matches = isViewGuard ? this.serverViewGuardMatches : this.serverSourceGuardMatches;
        return this.#runCommandString(argv[matches ? 5 : 6]!);
      }
      case "has-session": {
        const name = argv.at(-1)?.replace(/^=/u, "") ?? "";
        return this.views.has(name) ? { status: "ok", stdout: "" } : { status: "not-found" };
      }
      case "show-environment": {
        const sessionId = argv[argv.indexOf("-t") + 1] ?? "";
        const name = [...this.sessionIds.entries()].find((entry) => entry[1] === sessionId)?.[0];
        const view = name ? this.views.get(name) : undefined;
        if (!view) return { status: "not-found" };
        if (argv.at(-1) !== GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT) {
          return { status: "failed" };
        }
        if (view.marker === null) return { status: "variable-not-found" };
        return {
          status: "ok",
          stdout: `${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=${view.marker}\n`,
        };
      }
      case "list-windows": {
        const target = argv[argv.indexOf("-t") + 1]?.replace(/^=/u, "") ?? "";
        const view = this.views.get(target);
        if (!view) return { status: "not-found" };
        return { status: "ok", stdout: `${view.windows.join("\n")}\n` };
      }
      case "list-panes": {
        const target = argv[argv.indexOf("-t") + 1] ?? "";
        if (!target.startsWith("=")) return { status: "ok", stdout: this.sourceOutput };
        const view = this.views.get(target.slice(1));
        if (!view) return { status: "not-found" };
        if (argv.at(-1) === "#{session_id}") {
          return { status: "ok", stdout: `${this.sessionId(target.slice(1))}\n` };
        }
        return {
          status: "ok",
          stdout: `${this.sessionId(target.slice(1))}\t${view.windows[0] ?? "@0"}\t%56\t${view.windows.length === 1 ? "1" : "2"}\t1\n`,
        };
      }
      case "list-sessions":
        return {
          status: "ok",
          stdout:
            this.sessionsOutput ??
            [...this.views.entries()]
              .map(([name]) => `${name}\t${this.sessionId(name)}`)
              .join("\n"),
        };
      case "kill-session": {
        const name = argv.at(-1)?.replace(/^=/u, "") ?? "";
        if (!this.views.has(name)) return { status: "not-found" };
        this.views.delete(name);
        this.sessionIds.delete(name);
        this.mutationCount += 1;
        return { status: "ok", stdout: "" };
      }
      case "attach-session":
      case "select-window":
      case "set-option":
      case "set-environment":
        this.mutationCount += 1;
        return { status: "ok", stdout: "" };
      case "display-message":
        return { status: "ok", stdout: `${argv.at(-1)}\n` };
      default:
        return { status: "failed" };
    }
  }
}

function plan(
  id = attachmentId,
  generation = 0,
  viewerMode: "interactive" | "read-only" = "interactive",
): GroupedTmuxAttachmentPlan {
  return planGroupedTmuxAttachment({
    attachmentId: id,
    generation,
    target: { workspaceName: "workspace.alpha", semanticPaneId: "pane.worker" },
    viewerMode,
    viewport: { cols: 120, rows: 40 },
    source: {
      sessionId: "$12",
      windowId: "@34",
      runtimePaneId: "%56",
      paneCount: 1,
    },
  });
}

function operation(
  selected: GuardedAttachmentViewOperation["operation"] = "create",
  selectedPlan = plan(),
  deadline = 2_000,
): GuardedAttachmentViewOperation {
  return {
    operation: selected,
    exactViewSessionTarget: `=${selectedPlan.identity.viewSessionName}`,
    deadline,
    source: {
      sessionId: "$12",
      windowId: "@34",
      runtimePaneId: "%56",
      paneCount: 1,
    },
    plan: selectedPlan,
  };
}

function cleanup(selectedPlan = plan()): GuardedAttachmentCleanup {
  return {
    exactViewSessionTarget: `=${selectedPlan.identity.viewSessionName}`,
    markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
    expectedMarkerValue: selectedPlan.identity.markerValue,
    expectedWindowId: selectedPlan.identity.durableSource.windowId,
  };
}

function seed(runner: FakeRunner, selectedPlan = plan(), overrides: Partial<FakeView> = {}): void {
  runner.views.set(selectedPlan.identity.viewSessionName, {
    marker: selectedPlan.identity.markerValue,
    windows: [selectedPlan.identity.durableSource.windowId],
    ...overrides,
  });
  runner.sessionId(selectedPlan.identity.viewSessionName);
}

function clientTransport(runner: FakeRunner) {
  return {
    beginGuardedAttach: (input: TmuxAttachmentClientTransportInput) => {
      const result = runner.run(planCanonicalTmuxAttachmentClientCommand(input));
      let outcome: TmuxAttachmentClientTransportOutcome = { status: "executed" };
      if (result.status !== "ok") {
        outcome = { status: "failed" };
      } else {
        if (result.stdout.trim() === "__tmux_ide_source_proof_mismatch_v1__") {
          outcome = { status: "source-proof-mismatch" };
        }
        if (result.stdout.trim() === "__tmux_ide_view_proof_mismatch_v1__") {
          outcome = { status: "view-proof-mismatch" };
        }
      }
      return {
        status: "claimed" as const,
        attemptId: "728e8e59-00e7-4b6b-b794-1f55686f39ea",
        attachmentId: input.identity.attachmentId,
        generation: input.identity.generation,
        outcome: Promise.resolve(outcome),
      };
    },
  };
}

function exposed(error: unknown): string {
  return `${JSON.stringify(error)} ${inspect(error)}`;
}

describe("TmuxAttachmentViewExecutor guarded execution", () => {
  it("revalidates the exact source tuple and creates only the canonical server plan", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_999 });

    await expect(executor.executeGuardedViewOperation(operation())).resolves.toBe("executed");
    expect(runner.views.get(selectedPlan.identity.viewSessionName)).toEqual({
      marker: selectedPlan.identity.markerValue,
      windows: ["@34"],
    });
    expect(runner.calls).toContainEqual([
      "list-panes",
      "-t",
      "$12:@34",
      "-F",
      "#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}",
    ]);
    expect(runner.calls).toContainEqual(selectedPlan.create.command.argv.slice(0, 7));
    expect(runner.calls.some((argv) => argv[0] === "if-shell")).toBe(true);
    expect(runner.mutationCount).toBe(1);
  });

  it("checks the immutable deadline after the final proof with zero exact-deadline mutation", async () => {
    const runner = new FakeRunner();
    let now = 1_999;
    runner.before = (argv) => {
      if (argv[0] === "list-panes") now = 2_000;
    };
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => now });

    await expect(executor.executeGuardedViewOperation(operation())).resolves.toBe("lease-expired");
    expect(runner.mutationCount).toBe(0);
    expect(runner.calls.some((argv) => argv[0] === "new-session")).toBe(false);
  });

  it.each([
    ["session churn", "$99\t@34\t%56\t1\n"],
    ["window churn", "$12\t@99\t%56\t1\n"],
    ["pane churn", "$12\t@34\t%99\t1\n"],
    ["split window", "$12\t@34\t%56\t2\n"],
    ["duplicate source rows", "$12\t@34\t%56\t1\n$12\t@34\t%56\t1\n"],
  ])("returns a proof mismatch without mutation on %s", async (_label, sourceOutput) => {
    const runner = new FakeRunner();
    runner.sourceOutput = sourceOutput;
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    await expect(executor.executeGuardedViewOperation(operation())).resolves.toBe(
      "source-proof-mismatch",
    );
    expect(runner.mutationCount).toBe(0);
  });

  it("proves the durable session/window tuple even when a linked view shares the global pane id", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: clientTransport(runner),
      now: () => 1_000,
    });

    await expect(
      executor.executeGuardedViewOperation(operation("attach", selectedPlan)),
    ).resolves.toMatchObject({
      status: "executed",
      clientClaim: {
        attachmentId,
        generation: 0,
        attemptId: "728e8e59-00e7-4b6b-b794-1f55686f39ea",
      },
    });
    const proofCall = runner.calls.find(
      (argv) => argv[0] === "list-panes" && argv[2] === "$12:@34",
    );
    expect(proofCall?.[2]).toBe("$12:@34");
    expect(proofCall).not.toContain("%56");
    expect(runner.calls.at(-1)).toEqual(selectedPlan.attach.argv);
  });

  it("rechecks source inside the tmux server queue and fails closed on last-moment churn", async () => {
    const runner = new FakeRunner();
    runner.before = (argv) => {
      if (argv[0] === "list-panes") runner.serverSourceGuardMatches = false;
    };
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });

    await expect(executor.executeGuardedViewOperation(operation())).resolves.toBe(
      "source-proof-mismatch",
    );
    expect(runner.mutationCount).toBe(0);
    expect(runner.calls.some((argv) => argv[0] === "new-session")).toBe(false);
  });

  it("preserves a last-moment source guard failure through the client transport", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    runner.before = (argv) => {
      if (argv[0] === "list-panes" && argv[2] === "$12:@34") {
        runner.serverSourceGuardMatches = false;
      }
    };
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: clientTransport(runner),
      now: () => 1_000,
    });

    await expect(
      executor.executeGuardedViewOperation(operation("attach", selectedPlan)),
    ).resolves.toBe("source-proof-mismatch");
    expect(runner.mutationCount).toBe(0);
  });

  it("preserves a last-moment view guard failure through the client transport", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    runner.serverViewGuardMatches = false;
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: clientTransport(runner),
      now: () => 1_000,
    });

    await expect(
      executor.executeGuardedViewOperation(operation("recover", selectedPlan)),
    ).rejects.toMatchObject({ code: "view-state-mismatch" });
    expect(runner.mutationCount).toBe(0);
  });

  it("rejects injected or noncanonical argv before touching tmux", async () => {
    const runner = new FakeRunner();
    const hostile = structuredClone(plan()) as GroupedTmuxAttachmentPlan & {
      create: { command: { argv: string[] } };
    };
    hostile.create.command.argv.push(";", "run-shell", "touch /tmp/owned");
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });

    await expect(
      executor.executeGuardedViewOperation(operation("create", hostile)),
    ).rejects.toEqual(new TmuxAttachmentViewExecutorError("invalid-request"));
    expect(runner.calls).toHaveLength(0);
  });

  it("validates ownership/topology before attach and recover", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan, { marker: "v1:00000000-0000-4000-8000-000000000000:0" });
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: clientTransport(runner),
      now: () => 1_000,
    });
    await expect(
      executor.executeGuardedViewOperation(operation("attach", selectedPlan)),
    ).rejects.toMatchObject({ code: "view-state-mismatch" });
    expect(runner.mutationCount).toBe(0);

    seed(runner, selectedPlan, { windows: ["@35"] });
    await expect(
      executor.executeGuardedViewOperation(operation("recover", selectedPlan)),
    ).rejects.toMatchObject({ code: "view-state-mismatch" });
    expect(runner.mutationCount).toBe(0);
  });

  it.each(["attach", "recover"] as const)(
    "rejects %s without an explicit client transport before any command or mutation",
    async (selected) => {
      const runner = new FakeRunner();
      seed(runner);
      runner.calls.length = 0;
      const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });

      await expect(executor.executeGuardedViewOperation(operation(selected))).rejects.toMatchObject(
        {
          code: "attachment-transport-unavailable",
          message: "A tmux client transport is required for this attachment operation.",
        },
      );
      expect(runner.calls).toHaveLength(0);
      expect(runner.mutationCount).toBe(0);
    },
  );

  it("synchronously claims the PTY before yielding after the final daemon proof", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    let yielded = false;
    let began = false;
    runner.before = (argv) => {
      if (argv[0] === "list-panes" && argv[2] === "$12:@34") {
        queueMicrotask(() => {
          yielded = true;
        });
      }
    };
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: {
        beginGuardedAttach(input) {
          began = true;
          expect(yielded).toBe(false);
          expect(input).not.toHaveProperty("command");
          expect(planCanonicalTmuxAttachmentClientCommand(input).argv[0]).toBe("if-shell");
          return {
            status: "claimed",
            attemptId: "728e8e59-00e7-4b6b-b794-1f55686f39ea",
            attachmentId: input.identity.attachmentId,
            generation: input.identity.generation,
            outcome: Promise.resolve({ status: "executed" }),
          };
        },
      },
      now: () => 1_000,
    });

    await expect(
      executor.executeGuardedViewOperation(operation("attach", selectedPlan)),
    ).resolves.toMatchObject({
      status: "executed",
      clientClaim: { attemptId: "728e8e59-00e7-4b6b-b794-1f55686f39ea" },
    });
    expect(began).toBe(true);
    expect(yielded).toBe(true);
  });

  it("preserves a typed read-only transport refusal before client spawn", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan(attachmentId, 0, "read-only");
    seed(runner, selectedPlan);
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: {
        beginGuardedAttach() {
          throw new TmuxAttachmentClientTransportError("read_only_unavailable");
        },
      },
      now: () => 1_000,
    });

    await expect(
      executor.executeGuardedViewOperation(operation("attach", selectedPlan)),
    ).rejects.toMatchObject({
      code: "read_only_unavailable",
      message: "Read-only terminal attachment is not proven safe on this daemon.",
    });
  });

  it("fails closed on a transport outcome outside the static protocol", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: {
        beginGuardedAttach(input) {
          return {
            status: "claimed",
            attemptId: "728e8e59-00e7-4b6b-b794-1f55686f39ea",
            attachmentId: input.identity.attachmentId,
            generation: input.identity.generation,
            outcome: Promise.resolve({ status: "hostile" } as never),
          };
        },
      },
      now: () => 1_000,
    });

    await expect(
      executor.executeGuardedViewOperation(operation("attach", selectedPlan)),
    ).rejects.toMatchObject({ code: "mutation-outcome-uncertain" });
  });

  it("reports a partial mutation as uncertain, rolls back only a canonical view, and leaks nothing", async () => {
    const runner = new FakeRunner();
    runner.partialCreateFailure = true;
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    try {
      await executor.executeGuardedViewOperation(operation());
      throw new Error("expected uncertain mutation");
    } catch (error) {
      expect(error).toBeInstanceOf(TmuxAttachmentViewExecutorError);
      expect(error).toMatchObject({ code: "mutation-outcome-uncertain" });
      expect((error as Error).cause).toBeUndefined();
      expect(exposed(error)).not.toMatch(/raw-secret|%999|\$888|@777/u);
    }
    expect(runner.views.size).toBe(0);
    expect(runner.calls.some((argv) => argv[0] === "kill-session")).toBe(true);
  });

  it("sanitizes arbitrary runner exceptions without retaining a cause", async () => {
    const runner = new FakeRunner();
    runner.fail = (argv) => (argv[0] === "list-panes" ? "throw" : null);
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    try {
      await executor.executeGuardedViewOperation(operation());
      throw new Error("expected command failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "tmux-command-failed" });
      expect((error as Error).cause).toBeUndefined();
      expect(exposed(error)).not.toMatch(/raw-secret|%999|\$888|@777/u);
    }
  });

  it("sanitizes exact marker-query failures without retaining tmux output", async () => {
    const runner = new FakeRunner();
    seed(runner);
    runner.fail = (argv) => (argv[0] === "show-environment" ? "throw" : null);
    const executor = new TmuxAttachmentViewExecutor({ runner });

    try {
      await executor.guardedCleanup(cleanup());
      throw new Error("expected command failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "tmux-command-failed" });
      expect((error as Error).cause).toBeUndefined();
      expect(exposed(error)).not.toMatch(/raw-secret|%999|\$888|@777/u);
    }
    expect(runner.calls).toContainEqual([
      "show-environment",
      "-t",
      runner.sessionId(plan().identity.viewSessionName),
      GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
    ]);
  });
});

describe("TmuxAttachmentViewExecutor guarded cleanup", () => {
  it("kills only an exact canonical marked one-window view", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    const executor = new TmuxAttachmentViewExecutor({ runner });

    await expect(executor.guardedCleanup(cleanup(selectedPlan))).resolves.toBe("cleaned");
    expect(runner.views.has(selectedPlan.identity.viewSessionName)).toBe(false);
    const viewCommands = runner.calls.filter((argv) =>
      ["has-session", "show-options", "list-windows", "kill-session"].includes(argv[0]!),
    );
    for (const argv of viewCommands) {
      const target = argv[argv.indexOf("-t") + 1];
      expect(target).toBe(`=${selectedPlan.identity.viewSessionName}`);
    }
  });

  it("rechecks marker/topology in the final tmux queue and does not kill after churn", async () => {
    const runner = new FakeRunner();
    seed(runner);
    runner.serverViewGuardMatches = false;
    const executor = new TmuxAttachmentViewExecutor({ runner });

    await expect(executor.guardedCleanup(cleanup())).resolves.toBe("topology-mismatch");
    expect(runner.views.has(plan().identity.viewSessionName)).toBe(true);
    expect(runner.mutationCount).toBe(0);
  });

  it.each([
    ["ownership-mismatch", { marker: "v1:00000000-0000-4000-8000-000000000000:0" }],
    ["topology-mismatch", { windows: ["@35"] }],
    ["topology-mismatch", { windows: ["@34", "@35"] }],
  ] as const)("returns %s without mutation", async (expected, overrides) => {
    const runner = new FakeRunner();
    seed(runner, plan(), overrides);
    const executor = new TmuxAttachmentViewExecutor({ runner });
    await expect(executor.guardedCleanup(cleanup())).resolves.toBe(expected);
    expect(runner.mutationCount).toBe(0);
  });

  it("serializes execute and cleanup across distinct executor/lease-manager boundaries", async () => {
    const runner = new FakeRunner();
    const firstPlan = plan();
    const secondPlan = plan(secondAttachmentId);
    seed(runner, secondPlan);
    const operationSerializer = new TmuxAttachmentOperationSerializer();
    const first = new TmuxAttachmentViewExecutor({
      runner,
      operationSerializer,
      now: () => 1_000,
    });
    const second = new TmuxAttachmentViewExecutor({
      runner,
      operationSerializer,
      now: () => 1_000,
    });

    const creating = first.executeGuardedViewOperation(operation("create", firstPlan));
    const cleaning = second.guardedCleanup(cleanup(secondPlan));
    await expect(Promise.all([creating, cleaning])).resolves.toEqual(["executed", "cleaned"]);

    const createIndex = runner.calls.findIndex((argv) => argv[0] === "new-session");
    const secondProbeIndex = runner.calls.findIndex(
      (argv) =>
        argv[0] === "has-session" && argv.at(-1) === `=${secondPlan.identity.viewSessionName}`,
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(secondProbeIndex).toBeGreaterThan(createIndex);
  });
});

describe("TmuxAttachmentViewExecutor marked-view enumeration", () => {
  it("returns only validated bounded identities and queries each view by exact name", async () => {
    const runner = new FakeRunner();
    const first = plan();
    const second = plan(secondAttachmentId, 2);
    seed(runner, first);
    seed(runner, second, { marker: null });
    runner.sessionsOutput = [
      "durable-source\t$1",
      `${first.identity.viewSessionName}\t${runner.sessionId(first.identity.viewSessionName)}`,
      `${second.identity.viewSessionName}\t${runner.sessionId(second.identity.viewSessionName)}`,
    ].join("\n");
    const executor = new TmuxAttachmentViewExecutor({ runner });

    await expect(
      executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      ),
    ).resolves.toEqual([
      {
        viewSessionName: first.identity.viewSessionName,
        markerValue: first.identity.markerValue,
        windowIds: ["@34"],
      },
      {
        viewSessionName: second.identity.viewSessionName,
        markerValue: null,
        windowIds: ["@34"],
      },
    ]);
    for (const argv of runner.calls.filter((entry) => entry[0] === "list-windows")) {
      expect(argv[argv.indexOf("-t") + 1]).toMatch(/^=_tmux-ide-view-v1-/u);
    }
    for (const argv of runner.calls.filter((entry) => entry[0] === "show-environment")) {
      expect(argv).toHaveLength(4);
      expect(argv.at(-1)).toBe(GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT);
    }
  });

  it.each([
    ["malformed row", `${plan().identity.viewSessionName}`],
    [
      "duplicate row",
      `${plan().identity.viewSessionName}\t$90\n${plan().identity.viewSessionName}\t$90`,
    ],
    ["noncanonical generated name", `${GROUPED_TMUX_VIEW_SESSION_PREFIX}not-an-id-0\t$90`],
    ["oversized output", "x".repeat(128 * 1024 + 1)],
  ])("fails closed with a static error for %s", async (_label, sessionsOutput) => {
    const runner = new FakeRunner();
    runner.sessionsOutput = sessionsOutput;
    const executor = new TmuxAttachmentViewExecutor({ runner });
    try {
      await executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      );
      throw new Error("expected invalid output");
    } catch (error) {
      expect(error).toBeInstanceOf(TmuxAttachmentViewExecutorError);
      expect(error).toMatchObject({ code: "invalid-tmux-output" });
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).toBe(
        "Trusted tmux attachment discovery returned invalid output.",
      );
    }
  });

  it("rejects duplicate, malformed, and overlarge per-view window output", async () => {
    const runner = new FakeRunner();
    const selectedPlan = plan();
    seed(runner, selectedPlan);
    runner.rawOutput = (argv) => (argv[0] === "list-windows" ? "@34\n@34\n" : null);
    const executor = new TmuxAttachmentViewExecutor({ runner });
    await expect(
      executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      ),
    ).rejects.toMatchObject({ code: "invalid-tmux-output" });
  });
});
