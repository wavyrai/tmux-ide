import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIPBOARD_HOOK_SLOT_LIMIT,
  acquireClipboardPaneHook,
  ensureClipboardAcquisitionRollback,
  isExactClipboardAcquisitionRollback,
  retireClipboardPaneHook,
  rollbackClipboardPaneHookAcquisition,
} from "./tui-testdrive-clipboard-hook.mjs";

const NONCE_A = "00000001-1234-4234-8234-123456789abc";
const NONCE_B = "3b9aca01-1234-4234-8234-123456789abc";

function fakeTmux(initialHooks = [], { onTransport } = {}) {
  const hooks = new Map(initialHooks.map(({ name, command }) => [name, command]));
  let owner = "";
  const faults = {};
  const calls = [];
  const execute = (args) => {
    if (args[0] === "wait-for") return "";
    if (args[0] === "display-message") {
      const format = args.at(-1);
      if (format.startsWith("__TMUX_IDE_CLIPBOARD_OWNER__")) {
        return `${format.replace("#{@tmux_ide_testdrive_clipboard_owner}", owner)}\n`;
      }
      return `${format}\n`;
    }
    if (args[0] === "show-options") return owner ? `${owner}\n` : "";
    if (args[0] === "set-option" && args.includes("-po")) {
      if (owner) throw Object.assign(new Error("already set"), { stderr: "already set" });
      owner = args.at(-1);
      return "";
    }
    if (args[0] === "set-option" && args.includes("-pu")) {
      owner = "";
      return "";
    }
    if (args[0] === "show-hooks") {
      const value = [...hooks]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, command]) => `${name} ${command}`)
        .join("\n");
      return value ? `${value}\n` : "pane-set-clipboard\n";
    }
    if (args[0] === "set-hook" && args.includes("-ap")) {
      let index = 0;
      while (hooks.has(`pane-set-clipboard[${index}]`)) index += 1;
      hooks.set(`pane-set-clipboard[${index}]`, args.at(-1));
      return "";
    }
    if (args[0] === "set-hook" && args.includes("-pu")) {
      if (faults.unsetThrows) {
        if (Number.isSafeInteger(faults.unsetThrows)) faults.unsetThrows -= 1;
        throw new Error("unset failed");
      }
      if (faults.unsetTimeout) {
        if (Number.isSafeInteger(faults.unsetTimeout)) faults.unsetTimeout -= 1;
        throw new Error("unset timed out");
      }
      if (!faults.unsetRemains) hooks.delete(args.at(-1));
      else if (Number.isSafeInteger(faults.unsetRemains)) faults.unsetRemains -= 1;
      return "";
    }
    throw new Error(`unexpected tmux command ${args.join(" ")}`);
  };
  const run = (args) => {
    calls.push(args);
    onTransport?.(args, calls.length);
    if (faults.failTransport === calls.length) throw new Error("tmux transport timed out");
    if (faults.partialOwnerUnsetHookRetained && args[0] === "set-hook" && args.includes("-pu")) {
      owner = "";
      faults.partialOwnerUnsetHookRetained = false;
      throw new Error("tmux grouped retirement timed out");
    }
    const groups = [];
    let current = [];
    for (const value of args) {
      if (value === ";") {
        groups.push(current);
        current = [];
      } else {
        current.push(value);
      }
    }
    groups.push(current);
    return groups.map(execute).join("");
  };
  return {
    run,
    hooks,
    calls,
    faults,
    owner: () => owner,
    replace(name, command) {
      hooks.set(name, command);
    },
  };
}

const remaining = () => 1_000;

test("every acquisition transport failure rolls back only exact owned state", () => {
  for (let failureCall = 1; failureCall <= 7; failureCall += 1) {
    const foreign = { name: "pane-set-clipboard[0]", command: "run-shell foreign" };
    const tmux = fakeTmux([foreign]);
    tmux.faults.failTransport = failureCall;
    assert.throws(
      () =>
        acquireClipboardPaneHook({
          paneId: "%7",
          ownerToken: NONCE_A,
          command: "run-shell owned-a",
          runTmux: tmux.run,
          remaining,
          cleanupRemaining: remaining,
        }),
      (error) => {
        assert.equal(
          error.clipboardLeaseEvidence.retirementExact,
          true,
          `failure call ${failureCall}`,
        );
        assert.equal(isExactClipboardAcquisitionRollback(error.clipboardLeaseEvidence), true);
        assert.equal(
          isExactClipboardAcquisitionRollback({ ...error.clipboardLeaseEvidence }),
          false,
        );
        return true;
      },
    );
    assert.equal(tmux.owner(), "", `failure call ${failureCall}`);
    assert.deepEqual(
      [...tmux.hooks],
      [[foreign.name, foreign.command]],
      `failure call ${failureCall}`,
    );
  }
});

test("only capability-authenticated exact rollback evidence is reusable", () => {
  const tmux = fakeTmux();
  const exact = rollbackClipboardPaneHookAcquisition({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  assert.equal(isExactClipboardAcquisitionRollback(exact), true);
  const callsBeforeReuse = tmux.calls.length;
  assert.equal(
    ensureClipboardAcquisitionRollback({
      evidence: exact,
      paneId: "%7",
      ownerToken: NONCE_A,
      command: "run-shell owned-a",
      runTmux: tmux.run,
      remaining,
    }),
    exact,
  );
  assert.equal(tmux.calls.length, callsBeforeReuse);
  for (const value of [
    { ...exact },
    { ...exact, finalHookAbsent: false },
    { ...exact, extra: true },
    null,
  ]) {
    assert.equal(isExactClipboardAcquisitionRollback(value), false);
  }
  const callsBeforeForgery = tmux.calls.length;
  const reverified = ensureClipboardAcquisitionRollback({
    evidence: { ...exact },
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  assert.notEqual(reverified, exact);
  assert.equal(isExactClipboardAcquisitionRollback(reverified), true);
  assert.ok(tmux.calls.length > callsBeforeForgery);
});

test("outer rollback reuses an exact inner cleanup after most of its reserve is consumed", () => {
  const tmux = fakeTmux();
  tmux.faults.failTransport = 6;
  let cleanupCalls = 0;
  const cleanupRemaining = () => {
    cleanupCalls += 1;
    return Math.max(1, 650 - cleanupCalls * 80);
  };
  let evidence;
  assert.throws(
    () =>
      acquireClipboardPaneHook({
        paneId: "%7",
        ownerToken: NONCE_A,
        command: "run-shell owned-a",
        runTmux: tmux.run,
        remaining,
        cleanupRemaining,
      }),
    (error) => {
      evidence = error.clipboardLeaseEvidence;
      assert.equal(isExactClipboardAcquisitionRollback(evidence), true);
      return true;
    },
  );
  assert.ok(cleanupCalls >= 6);
  const transportCalls = tmux.calls.length;
  const remainingCalls = cleanupCalls;
  assert.equal(
    ensureClipboardAcquisitionRollback({
      evidence,
      paneId: "%7",
      ownerToken: NONCE_A,
      command: "run-shell owned-a",
      runTmux: tmux.run,
      remaining: cleanupRemaining,
    }),
    evidence,
  );
  assert.equal(tmux.calls.length, transportCalls);
  assert.equal(cleanupCalls, remainingCalls);
});

test("rollback timeout reports residue and a later global cleanup removes it", () => {
  const tmux = fakeTmux();
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  assert.throws(
    () =>
      rollbackClipboardPaneHookAcquisition({
        paneId: "%7",
        ownerToken: NONCE_A,
        command: lease.command,
        runTmux: tmux.run,
        remaining: () => {
          throw new Error("rollback deadline");
        },
      }),
    (error) => {
      assert.equal(error.clipboardLeaseEvidence.retirementExact, false);
      assert.equal(error.clipboardLeaseEvidence.finalOwnerAbsent, false);
      assert.equal(error.clipboardLeaseEvidence.finalHookAbsent, false);
      return true;
    },
  );
  assert.equal(tmux.owner(), NONCE_A);
  assert.equal(tmux.hooks.get(lease.hookName), lease.command);
  assert.equal(
    rollbackClipboardPaneHookAcquisition({
      paneId: "%7",
      ownerToken: NONCE_A,
      command: lease.command,
      runTmux: tmux.run,
      remaining,
    }).retirementExact,
    true,
  );
  assert.equal(tmux.owner(), "");
  assert.equal(tmux.hooks.size, 0);
});

test("acquisition rollback never removes a foreign owner or hook", () => {
  const tmux = fakeTmux([{ name: "pane-set-clipboard[0]", command: "run-shell foreign" }]);
  const foreign = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_B,
    command: "run-shell foreign-owned",
    runTmux: tmux.run,
    remaining,
  });
  assert.throws(
    () =>
      rollbackClipboardPaneHookAcquisition({
        paneId: "%7",
        ownerToken: NONCE_A,
        command: "run-shell owned-a",
        runTmux: tmux.run,
        remaining,
      }),
    /foreign owner/u,
  );
  assert.equal(tmux.owner(), NONCE_B);
  assert.equal(tmux.hooks.get(foreign.hookName), foreign.command);
  retireClipboardPaneHook({ paneId: "%7", lease: foreign, runTmux: tmux.run, remaining });
});

test("atomic append falls back after occupied hooks and retires only its exact command", () => {
  const tmux = fakeTmux([{ name: "pane-set-clipboard[0]", command: "run-shell foreign" }]);
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  assert.equal(lease.hookName, "pane-set-clipboard[1]");
  assert.equal(lease.candidateAttempts, 2);
  assert.equal(lease.occupiedCount, 1);
  assert.deepEqual(retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }), {
    candidateAttempts: 2,
    occupiedCount: 1,
    retirementExact: true,
    retirementStage: "complete",
    retirementElapsedMs: 0,
    finalOwnerAbsent: true,
    finalHookAbsent: true,
  });
  assert.equal(tmux.hooks.get("pane-set-clipboard[0]"), "run-shell foreign");
  assert.equal(tmux.owner(), "");
});

test("all bounded hook candidates fail without overwriting foreign hooks", () => {
  const initial = Array.from({ length: CLIPBOARD_HOOK_SLOT_LIMIT }, (_, index) => ({
    name: `pane-set-clipboard[${index}]`,
    command: `run-shell foreign-${index}`,
  }));
  const tmux = fakeTmux(initial);
  assert.throws(
    () =>
      acquireClipboardPaneHook({
        paneId: "%7",
        ownerToken: NONCE_A,
        command: "run-shell owned",
        runTmux: tmux.run,
        remaining,
      }),
    (error) => {
      assert.deepEqual(error.clipboardLeaseEvidence, {
        candidateAttempts: CLIPBOARD_HOOK_SLOT_LIMIT,
        occupiedCount: CLIPBOARD_HOOK_SLOT_LIMIT,
        retirementExact: false,
        retirementStage: "not-started",
        retirementElapsedMs: 0,
        finalOwnerAbsent: false,
        finalHookAbsent: false,
      });
      return true;
    },
  );
  assert.equal(tmux.hooks.size, CLIPBOARD_HOOK_SLOT_LIMIT);
  assert.equal(tmux.owner(), "");
});

test("legacy modulo-colliding nonces acquire sequentially without sharing a slot", () => {
  assert.equal(Number.parseInt(NONCE_A.slice(0, 8), 16) % 1_000_000_000, 1);
  assert.equal(Number.parseInt(NONCE_B.slice(0, 8), 16) % 1_000_000_000, 1);
  const tmux = fakeTmux();
  const first = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  retireClipboardPaneHook({ paneId: "%7", lease: first, runTmux: tmux.run, remaining });
  const second = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_B,
    command: "run-shell owned-b",
    runTmux: tmux.run,
    remaining,
  });
  assert.equal(second.hookName, "pane-set-clipboard[0]");
  retireClipboardPaneHook({ paneId: "%7", lease: second, runTmux: tmux.run, remaining });
});

test("retirement uses four bounded transports and fits the reserved budget at 100ms each", () => {
  let now = 0;
  const tmux = fakeTmux([], { onTransport: () => (now += 100) });
  const deadline = 2_000;
  const timedRemaining = () => {
    const value = deadline - now;
    if (value < 1) throw new Error("deadline exhausted");
    return value;
  };
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining: timedRemaining,
  });
  const beforeRetirement = tmux.calls.length;
  const result = retireClipboardPaneHook({
    paneId: "%7",
    lease,
    runTmux: tmux.run,
    remaining: timedRemaining,
    now: () => now,
  });
  assert.equal(tmux.calls.length - beforeRetirement, 4);
  assert.equal(result.retirementElapsedMs, 400);
  assert.equal(result.retirementExact, true);
  assert.equal(result.finalHookAbsent, true);
  assert.equal(result.finalOwnerAbsent, true);
});

for (const [label, offset, expectedStage] of [
  ["lock", 1, "lock"],
  ["preflight", 2, "preflight"],
  ["mutation", 3, "mutation"],
  ["unlock", 4, "unlock"],
]) {
  test(`retirement timeout at ${label} reports its bounded stage and never reports exact`, () => {
    const tmux = fakeTmux();
    const lease = acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_A,
      command: "run-shell owned-a",
      runTmux: tmux.run,
      remaining,
    });
    tmux.faults.failTransport = tmux.calls.length + offset;
    assert.throws(
      () =>
        retireClipboardPaneHook({
          paneId: "%7",
          lease,
          runTmux: tmux.run,
          remaining,
        }),
      (error) => {
        assert.equal(error.clipboardLeaseEvidence.retirementStage, expectedStage);
        assert.equal(error.clipboardLeaseEvidence.retirementExact, false);
        assert.equal(typeof error.clipboardLeaseEvidence.finalHookAbsent, "boolean");
        assert.equal(typeof error.clipboardLeaseEvidence.finalOwnerAbsent, "boolean");
        return true;
      },
    );
  });
}

test("concurrent arm is rejected and foreign replacement is never removed", () => {
  const tmux = fakeTmux();
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  assert.throws(() =>
    acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_B,
      command: "run-shell owned-b",
      runTmux: tmux.run,
      remaining,
    }),
  );
  tmux.replace(lease.hookName, "run-shell foreign-replacement");
  assert.throws(
    () => retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }),
    /ownership changed/u,
  );
  assert.equal(tmux.hooks.get(lease.hookName), "run-shell foreign-replacement");
  assert.equal(tmux.owner(), "");
});

for (const [name, configure] of [
  ["unset throws", (tmux) => (tmux.faults.unsetThrows = 1)],
  ["unset times out", (tmux) => (tmux.faults.unsetTimeout = 1)],
]) {
  test(`retirement fails closed when ${name} and does not poison the next owner`, () => {
    const tmux = fakeTmux();
    const lease = acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_A,
      command: "run-shell owned-a",
      runTmux: tmux.run,
      remaining,
    });
    configure(tmux);
    assert.throws(() =>
      retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }),
    );
    assert.equal(tmux.owner(), "");
    tmux.faults.unsetThrows = false;
    tmux.faults.unsetTimeout = false;
    tmux.faults.unsetRemains = false;
    const next = acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_B,
      command: "run-shell owned-b",
      runTmux: tmux.run,
      remaining,
    });
    retireClipboardPaneHook({ paneId: "%7", lease: next, runTmux: tmux.run, remaining });
  });
}

test("a transient retained hook is reaped and proved absent before success", () => {
  const tmux = fakeTmux();
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  tmux.faults.unsetRemains = 1;
  const result = retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining });
  assert.equal(result.retirementExact, true);
  assert.equal(result.finalHookAbsent, true);
  assert.equal(result.finalOwnerAbsent, true);
  assert.equal(tmux.hooks.size, 0);
  assert.equal(tmux.owner(), "");
});

test("persistent retirement failure retains exact ownership and fences the next operation", () => {
  const tmux = fakeTmux();
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  tmux.faults.unsetThrows = true;
  assert.throws(
    () => retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }),
    (error) => {
      assert.equal(error.clipboardLeaseEvidence.retirementExact, false);
      assert.equal(error.clipboardLeaseEvidence.finalHookAbsent, false);
      assert.equal(error.clipboardLeaseEvidence.finalOwnerAbsent, false);
      return true;
    },
  );
  assert.equal(tmux.owner(), NONCE_A);
  assert.throws(() =>
    acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_B,
      command: "run-shell owned-b",
      runTmux: tmux.run,
      remaining,
    }),
  );
  tmux.faults.unsetThrows = false;
  assert.equal(
    retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }).retirementExact,
    true,
  );
});

test("persistent retained hook restores its exact owner fence until a later cleanup succeeds", () => {
  const tmux = fakeTmux();
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  tmux.faults.unsetRemains = true;
  assert.throws(
    () => retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }),
    (error) => {
      assert.equal(error.clipboardLeaseEvidence.retirementStage, "verification");
      assert.equal(error.clipboardLeaseEvidence.finalHookAbsent, false);
      assert.equal(error.clipboardLeaseEvidence.finalOwnerAbsent, false);
      return true;
    },
  );
  assert.equal(tmux.owner(), NONCE_A);
  assert.throws(() =>
    acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_B,
      command: "run-shell owned-b",
      runTmux: tmux.run,
      remaining,
    }),
  );
  tmux.faults.unsetRemains = false;
  assert.equal(
    retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }).retirementExact,
    true,
  );
});

test("partial grouped timeout with hook retained and owner absent restores the exact owner fence", () => {
  const tmux = fakeTmux();
  const lease = acquireClipboardPaneHook({
    paneId: "%7",
    ownerToken: NONCE_A,
    command: "run-shell owned-a",
    runTmux: tmux.run,
    remaining,
  });
  tmux.faults.partialOwnerUnsetHookRetained = true;
  assert.throws(
    () => retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }),
    (error) => {
      assert.equal(error.clipboardLeaseEvidence.retirementStage, "mutation");
      assert.equal(error.clipboardLeaseEvidence.finalHookAbsent, false);
      assert.equal(error.clipboardLeaseEvidence.finalOwnerAbsent, false);
      return true;
    },
  );
  assert.equal(tmux.owner(), NONCE_A);
  assert.equal(tmux.hooks.get(lease.hookName), lease.command);
  assert.throws(() =>
    acquireClipboardPaneHook({
      paneId: "%7",
      ownerToken: NONCE_B,
      command: "run-shell owned-b",
      runTmux: tmux.run,
      remaining,
    }),
  );
  assert.equal(
    retireClipboardPaneHook({ paneId: "%7", lease, runTmux: tmux.run, remaining }).retirementExact,
    true,
  );
});
