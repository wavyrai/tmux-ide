import { describe, expect, it, vi } from "vitest";
import {
  PANE_SOURCE_CREDENTIAL_OPTION,
  PaneSourceCredentialAuthority,
  reconcilePaneSourceCredentialsAtStartup,
} from "./pane-source-credentials.ts";

describe("PaneSourceCredentialAuthority", () => {
  it("deduplicates workspace aliases before concurrent startup reconciliation", async () => {
    const installed = new Map<string, string>();
    const issuedTokens: string[] = [];
    const execute = (args: readonly string[]) => {
      if (args[0] === "list-panes") return `%1\tpane.editor\t${installed.get("%1") ?? ""}`;
      if (args[0] === "set-option") {
        installed.set(args[3]!, args[5]!);
        issuedTokens.push(args[5]!);
        return "";
      }
      throw new Error(`unexpected tmux call: ${args.join(" ")}`);
    };
    const run = vi.fn(execute);
    const runAsync = vi.fn(async (args: readonly string[]) => execute(args));
    const authority = new PaneSourceCredentialAuthority({ run, runAsync });

    await expect(
      reconcilePaneSourceCredentialsAtStartup(authority, ["alpha", "alpha"]),
    ).resolves.toBe("complete");

    expect(runAsync).toHaveBeenCalledTimes(2);
    expect(issuedTokens).toHaveLength(1);
    expect(authority.resolve(issuedTokens[0], "alpha", "pane.editor")).toBe("pane.editor");
  });

  it("bounds startup reconciliation and aborts ignored late work", async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseListPanes: ((rows: string) => void) | undefined;
    let setOptionCalls = 0;
    const authority = new PaneSourceCredentialAuthority({
      run: () => "",
      runAsync: (args, signal) => {
        observedSignal = signal;
        if (args[0] === "set-option") {
          setOptionCalls += 1;
          return Promise.resolve("");
        }
        return new Promise<string>((resolve) => {
          releaseListPanes = resolve;
        });
      },
    });

    await expect(reconcilePaneSourceCredentialsAtStartup(authority, ["alpha"], 5)).resolves.toBe(
      "timed-out",
    );
    expect(observedSignal?.aborted).toBe(true);

    releaseListPanes?.("%1\tpane.editor\t");
    await Promise.resolve();
    await Promise.resolve();
    expect(setOptionCalls).toBe(0);
  });

  it("reconciles credential grants through the async monitor shell", async () => {
    const installed = new Map<string, string>();
    const runAsync = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "list-panes") return `%1\tsemantic-1\t${installed.get("%1") ?? ""}`;
      if (args[0] === "set-option") {
        installed.set(args[3]!, args[5]!);
        return "";
      }
      throw new Error(`unexpected tmux call: ${args.join(" ")}`);
    });
    const run = vi.fn((args: readonly string[]) => {
      if (args[0] === "list-panes") return `%1\tsemantic-1\t${installed.get("%1") ?? ""}`;
      if (args[0] === "set-option") {
        installed.set(args[3]!, args[5]!);
        return "";
      }
      throw new Error(`unexpected tmux call: ${args.join(" ")}`);
    });
    const authority = new PaneSourceCredentialAuthority({ run, runAsync });

    await authority.reconcileSessionAsync("alpha");

    const credential = installed.get("%1");
    expect(credential).toBeTruthy();
    expect(runAsync).toHaveBeenCalledTimes(2);
    expect(authority.resolve(credential, "alpha", "semantic-1")).toBe("semantic-1");
  });

  it("mints exact pane grants, revokes churn, and invalidates on generation restart", () => {
    let topology: ReadonlyArray<readonly [string, string]> = [
      ["%1", "pane.editor"],
      ["%2", "pane.tests"],
    ];
    const options = new Map<string, string>();
    const run = vi.fn((args: readonly string[]) => {
      if (args[0] === "list-panes")
        return topology
          .map(([runtimePaneId, semanticPaneId]) =>
            [runtimePaneId, semanticPaneId, options.get(runtimePaneId) ?? ""].join("\t"),
          )
          .join("\n");
      if (args[0] === "set-option") {
        options.set(args[3]!, args[5]!);
        return "";
      }
      return "";
    });
    const first = new PaneSourceCredentialAuthority({ run });
    first.rotateSession("alpha");
    expect(run).toHaveBeenCalledWith([
      "list-panes",
      "-s",
      "-t",
      "=alpha",
      "-F",
      `#{pane_id}\t#{@tmux_ide_pane_id}\t#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]);
    const editor = options.get("%1")!;
    const tests = options.get("%2")!;
    expect(run).toHaveBeenCalledWith([
      "set-option",
      "-p",
      "-t",
      "%1",
      PANE_SOURCE_CREDENTIAL_OPTION,
      editor,
    ]);
    expect(first.resolve(editor, "alpha", "pane.editor")).toBe("pane.editor");
    expect(first.resolve(editor, "alpha", "pane.tests")).toBeNull();

    topology = [
      ["%2", "pane.tests"],
      ["%3", "pane.editor"],
    ];
    first.reconcileSession("alpha");
    expect(first.resolve(editor, "alpha", "pane.editor")).toBeNull();
    expect(options.get("%3")).toBeTruthy();
    expect(first.resolve(tests, "alpha", "pane.tests")).toBe("pane.tests");

    const replacement = new PaneSourceCredentialAuthority({ run });
    replacement.rotateSession("alpha");
    expect(replacement.resolve(tests, "alpha", "pane.tests")).toBeNull();
  });

  it("revokes and rotates when the pane option no longer matches daemon state", () => {
    const options = new Map<string, string>();
    const authority = new PaneSourceCredentialAuthority({
      run: (args) => {
        if (args[0] === "list-panes") {
          return `%1\tpane.editor\t${options.get("%1") ?? ""}`;
        }
        if (args[0] === "set-option") options.set(args[3]!, args[5]!);
        return "";
      },
    });
    authority.rotateSession("alpha");
    const first = options.get("%1")!;
    options.set("%1", "tampered-by-same-user-process");
    authority.reconcileSession("alpha");
    const replacement = options.get("%1")!;
    expect(replacement).not.toBe(first);
    expect(authority.resolve(first, "alpha", "pane.editor")).toBeNull();
    expect(authority.resolve(replacement, "alpha", "pane.editor")).toBe("pane.editor");
  });

  it("fails closed when live tmux identity cannot be reconciled", () => {
    let unavailable = false;
    const options = new Map<string, string>();
    const authority = new PaneSourceCredentialAuthority({
      run: (args) => {
        if (args[0] === "list-panes") {
          if (unavailable) throw new Error("session disappeared");
          return `%1\tpane.editor\t${options.get("%1") ?? ""}`;
        }
        if (args[0] === "set-option") options.set(args[3]!, args[5]!);
        return "";
      },
    });
    authority.rotateSession("alpha");
    const credential = options.get("%1")!;
    unavailable = true;
    expect(authority.resolve(credential, "alpha", "pane.editor")).toBeNull();
  });
});
