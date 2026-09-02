import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { discoverLiveSessionSummaries } from "./discovery.ts";

const sockets = new Set<string>();

function socket(): string {
  const name = `tmux-ide-catalog-${process.pid}-${randomUUID()}`;
  sockets.add(name);
  return name;
}

function tmux(name: string, args: readonly string[]): string {
  return execFileSync("tmux", ["-L", name, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function catalog(name: string) {
  return discoverLiveSessionSummaries((args) => tmux(name, args));
}

afterEach(() => {
  for (const name of sockets) {
    try {
      tmux(name, ["kill-server"]);
    } catch {
      // The test may already have retired this exact private server.
    }
  }
  sockets.clear();
});

describe("live Home catalog tmux identity", () => {
  it("survives rename and changes for same-name recreation on a private server", () => {
    const name = socket();
    tmux(name, ["new-session", "-d", "-s", "alpha"]);
    tmux(name, ["split-window", "-d", "-t", "alpha"]);
    const first = catalog(name)[0]!;
    expect(first).toMatchObject({ sessionName: "alpha", paneCount: 2 });

    tmux(name, ["rename-session", "-t", "alpha", "renamed"]);
    const renamed = catalog(name)[0]!;
    expect(renamed).toMatchObject({ sessionName: "renamed", paneCount: 2 });
    expect(renamed.liveSessionId).toBe(first.liveSessionId);

    tmux(name, ["kill-session", "-t", "renamed"]);
    tmux(name, ["new-session", "-d", "-s", "renamed"]);
    const recreated = catalog(name)[0]!;
    expect(recreated.sessionName).toBe("renamed");
    expect(recreated.liveSessionId).not.toBe(first.liveSessionId);
  });
});
