// Explicit owned daemon; Rust performs discovery and authenticated catalog IO.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
const { AbortSignal } = globalThis;
import { spawn, execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { once } from "node:events";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "./fixture-child.mjs";

const [testBinary, cliPath, guiTestBinary] = process.argv.slice(2);
assert(
  testBinary &&
    cliPath &&
    isAbsolute(testBinary) &&
    isAbsolute(cliPath) &&
    (!guiTestBinary || isAbsolute(guiTestBinary)),
  "Usage: node --import tsx native-discovery-smoke.mjs ABS_CLIENT_TEST_BINARY ABS_CLI [ABS_GUI_TEST_BINARY]",
);
const agentPickers = process.env.TMUX_IDE_NATIVE_TEST_AGENT_PICKERS === "owned-pickers";
assert(
  !agentPickers ||
    (guiTestBinary && process.env.TMUX_IDE_NATIVE_TEST_AGENT_ROSTER === "owned-agents"),
);
const agentRecovery = process.env.TMUX_IDE_NATIVE_TEST_AGENT_RECOVERY === "owned-recovery";
assert(!agentRecovery || guiTestBinary);
const fleet = await createScratchFleet({
  sessions: agentRecovery ? 34 : 2,
  windowsPerSession: 1,
  slug: "rust-discovery",
});
let daemon, child;
try {
  const agentRoster = process.env.TMUX_IDE_NATIVE_TEST_AGENT_ROSTER === "owned-agents";
  if (agentRoster) {
    const pane = fleet.initialPanes.find((p) => p.sessionName === fleet.sessionNames[1]).paneId;
    for (const [key, value] of [
      ["@agent_display_name", "Fixture native agent"],
      ["@agent_state", `${agentPickers ? "blocked" : "working"}:${Math.floor(Date.now() / 1000)}`],
    ])
      execFileSync(
        fleet.environment.TMUX_IDE_TMUX_BIN,
        ["-S", fleet.socketPath, "set-option", "-p", "-t", pane, key, value],
        { env: { ...process.env, ...fleet.environment }, timeout: 5000 },
      );
  }
  if (agentRecovery || agentPickers) {
    for (const pane of fleet.initialPanes) {
      if (pane.sessionName === fleet.sessionNames[1] && agentRoster) continue;
      for (const [key, value] of [
        ["@agent_display_name", `Fixture recovery ${fleet.sessionNames.indexOf(pane.sessionName)}`],
        ["@agent_state", `working:${Math.floor(Date.now() / 1000)}`],
      ])
        execFileSync(
          fleet.environment.TMUX_IDE_TMUX_BIN,
          ["-S", fleet.socketPath, "set-option", "-p", "-t", pane.paneId, key, value],
          { env: { ...process.env, ...fleet.environment }, timeout: 5000 },
        );
    }
  }
  daemon = await startDaemon(fleet, { cliPath });
  // Agent observation is read-only: explicitly register the second workspace
  // during fixture setup rather than expecting opening a picker to adopt it.
  if (agentPickers) await daemon.promote(fleet.sessionNames[0]);
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  const runs = [{ binary: testBinary, filter: "tmux_daemon::tests::", passed: 2 }];
  if (guiTestBinary)
    runs.push({
      binary: guiTestBinary,
      filter: "native_local_catalog_opens_owned_session_without_helper",
      passed: 1,
    });
  if (guiTestBinary && agentRoster)
    runs.push({
      binary: guiTestBinary,
      filter: "native_local_agent_roster_opens_exact_observed_pane",
      passed: 1,
    });
  if (guiTestBinary && process.env.TMUX_IDE_NATIVE_TEST_APPEARANCE === "owned-appearance")
    runs.push({
      binary: guiTestBinary,
      filter: "native_local_appearance_persists_without_helper",
      passed: 1,
    });
  if (agentRecovery)
    runs.push({
      binary: guiTestBinary,
      filter: "native_home_agent_recovery_loads_beyond_first_page_without_navigation",
      passed: 1,
    });
  if (agentPickers)
    runs.push({
      binary: guiTestBinary,
      filter: "native_agent_pickers_select_across_workspaces",
      passed: 1,
    });
  for (const run of runs) {
    child = spawn(run.binary, ["--ignored", "--nocapture", "--test-threads=1", run.filter], {
      env: {
        ...process.env,
        ...fleet.environment,
        TMUX_IDE_TEST_DAEMON_RECORD: join(fleet.daemonInfoDir, "daemon.json"),
        TMUX_IDE_TEST_ALLOW_MUTATION: "owned-scratch-fleet",
        TMUX_IDE_TEST_INPUT_SESSION: fleet.sessionNames[1],
        ...(agentRecovery
          ? { TMUX_IDE_TEST_RECOVERY_SESSIONS: JSON.stringify(fleet.sessionNames) }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let completionTriggered = false;
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-8192);
        if (
          agentPickers &&
          run.filter === "native_agent_pickers_select_across_workspaces" &&
          !completionTriggered &&
          output.includes("NATIVE_INACTIVE_AGENT_COMPLETION_READY")
        ) {
          completionTriggered = true;
          const pane = fleet.initialPanes.find(
            (p) => p.sessionName === fleet.sessionNames[0],
          ).paneId;
          execFileSync(
            fleet.environment.TMUX_IDE_TMUX_BIN,
            [
              "-S",
              fleet.socketPath,
              "set-option",
              "-p",
              "-t",
              pane,
              "@agent_state",
              `done:${Math.floor(Date.now() / 1000)}`,
            ],
            { env: { ...process.env, ...fleet.environment }, timeout: 5000 },
          );
        }
      });
    const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(60000) });
    assert.equal(signal, null);
    assert.equal(code, 0, output.replaceAll(daemon.record.authToken, "[redacted]"));
    assert.match(output, new RegExp(`${run.passed} passed`));
    if (agentPickers && run.filter === "native_agent_pickers_select_across_workspaces") {
      assert(completionTriggered);
      assert(output.includes("NATIVE_INACTIVE_AGENT_COMPLETION_VERIFIED"));
    }
  }
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  console.log(
    JSON.stringify({
      passed: true,
      nativeDiscovery: true,
      nativeAgentRecovery: agentRecovery,
      nativeAgentPickers: agentPickers,
      nativeTabCompletion: agentPickers,
      nativeAppearance: Boolean(
        guiTestBinary && process.env.TMUX_IDE_NATIVE_TEST_APPEARANCE === "owned-appearance",
      ),
      nativeAgentRosterAndSelection: Boolean(guiTestBinary && agentRoster),
      authenticatedCatalog: true,
      nativeSessionCreation: true,
      nativeWindowCreation: true,
      nativePaneInventory: true,
      nativeCapabilityRedemption: true,
      nativeGuiCatalogAndFrame: Boolean(guiTestBinary),
      nativeGuiLocalRegistryRead: Boolean(guiTestBinary),
      nativeGuiSplitLayout: Boolean(guiTestBinary),
      nativeGuiProgrammaticInput: Boolean(guiTestBinary),
      nativeGuiSessionCreation: Boolean(guiTestBinary),
      nativeGuiWindowCreation: Boolean(guiTestBinary),
      nativeGuiHistoryRestoration: Boolean(guiTestBinary),
      sourcePaneUnchanged: true,
      physicalInputTested: false,
    }),
  );
} finally {
  try {
    await stopFixtureChild(child);
  } finally {
    try {
      await daemon?.stop();
    } finally {
      await fleet.dispose();
    }
  }
}
