import { describe, expect, it } from "vitest";
import { standardScriptedChannel } from "./scripted-channel.ts";

describe("ScriptedChannelDriver", () => {
  it("owns capture/cursor completion and settles a real control protocol seed", async () => {
    const output: string[] = [];
    const driver = standardScriptedChannel({
      onOutput: (_pane, bytes) => output.push(new TextDecoder().decode(bytes)),
      onNotify: () => undefined,
      onExit: () => undefined,
    });
    await driver.channel.start();
    let capture: readonly string[] | null = null;
    let cursor: readonly string[] | null = null;
    driver.channel.commandListInline("capture-pane", 2, 1, (reply) => {
      capture = reply.lines;
    });
    driver.channel.commandInline("display-message", (reply) => {
      cursor = reply.lines;
    });
    await driver.settleUntil(() => capture !== null && cursor !== null, "seed probes");
    expect(capture).toEqual(["ready"]);
    expect(cursor).toEqual(["0 0 100 50"]);
    driver.output("%1", "hello\\015");
    expect(output).toEqual(["hello\r"]);
    await driver.channel.dispose();
  });

  it("fails a missing state transition within a bounded number of turns", async () => {
    const driver = standardScriptedChannel(
      { onOutput: () => undefined, onNotify: () => undefined, onExit: () => undefined },
      { maxTurns: 3 },
    );
    await driver.channel.start();
    await expect(driver.settleUntil(() => false, "impossible predicate")).rejects.toThrow(
      "within 3 turns",
    );
    await driver.channel.dispose();
  });
});
