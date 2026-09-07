import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "causal fixture restores native tmux screen and history after repeated alternate-screen probes",
  {
    skip: process.env.TMUX_IDE_CAUSAL_FIXTURE_LIVE !== "1",
  },
  async () => {
    const root = mkdtempSync("/tmp/tmi-causal-");
    const socket = join(root, "t");
    const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const fixture = fileURLToPath(
      new URL("./product-rig-causal-cell-fixture.mjs", import.meta.url),
    );
    const script = join(root, "pane.sh");
    writeFileSync(
      script,
      `#!/bin/sh
i=0
while [ "$i" -lt 45 ]; do printf 'ORIGINAL-%s\\n' "$i"; i=$((i + 1)); done
printf 'HANDOFF-MARKER\\n'
${quote(process.execPath)} ${quote(fixture)} --alternate-screen
printf 'RETURNED\\n'
exec sleep 30
`,
    );
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Private causal fixture did not reach the expected native state");
    };
    try {
      tmux(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "probe",
        "-x",
        "60",
        "-y",
        "12",
        `sh ${quote(script)}`,
      );
      await waitFor(
        () =>
          tmux("show-options", "-pqv", "-t", "probe:0.0", "@tmux_ide_causal_fixture").trim() ===
          "ready-v1",
      );
      assert.equal(tmux("display-message", "-p", "-t", "probe:0.0", "#{alternate_on}").trim(), "1");
      const trace = "00000000-0000-4000-8000-000000000001";
      for (const [index, letter] of ["X", "Y"].entries()) {
        tmux("send-keys", "-l", "-t", "probe:0.0", `reset-v1;probe${index}\n`);
        await waitFor(
          () =>
            tmux("show-options", "-pqv", "-t", "probe:0.0", "@tmux_ide_causal_fixture").trim() ===
            `ready-v1:probe${index}`,
        );
        tmux(
          "send-keys",
          "-l",
          "-t",
          "probe:0.0",
          `${trace};${Buffer.from(letter).toString("base64")}\n`,
        );
        await waitFor(() =>
          tmux("capture-pane", "-p", "-t", "probe:0.0").split("\n")[0].endsWith(letter),
        );
      }
      tmux("send-keys", "-t", "probe:0.0", "C-c");
      await waitFor(() => tmux("capture-pane", "-p", "-t", "probe:0.0").includes("RETURNED"));
      assert.equal(tmux("display-message", "-p", "-t", "probe:0.0", "#{alternate_on}").trim(), "0");
      const restored = tmux("capture-pane", "-p", "-S", "-100", "-t", "probe:0.0");
      for (let index = 0; index < 45; index++) assert.ok(restored.includes(`ORIGINAL-${index}\n`));
      assert.ok(restored.includes("HANDOFF-MARKER"));
      assert.equal(
        tmux("show-options", "-pqv", "-t", "probe:0.0", "@tmux_ide_causal_fixture").trim(),
        "",
      );
    } finally {
      try {
        tmux("kill-server");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
