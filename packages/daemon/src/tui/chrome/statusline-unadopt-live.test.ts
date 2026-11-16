/**
 * Unadopting one session must not take the server-wide chrome binds from the
 * other adopted sessions on the same tmux server (bug sweep, group I). Real
 * tmux on a private -S socket: TMUX names it, so runTmux reaches only it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./updater.ts", async (importActual) => ({
  ...(await importActual<typeof import("./updater.ts")>()),
  seedSessionStatus: () => {},
  startUpdaterIfNeeded: () => {},
  stopUpdater: () => {},
}));
vi.mock("./welcome.ts", () => ({ maybeShowWelcomePopup: () => {} }));
vi.mock("../../lib/app-config.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/app-config.ts")>();
  return { ...actual, getAppConfig: () => ({ keys: actual.DEFAULT_KEYS }) };
});

const { adoptSession, unadoptSession, STATUS_CLICK_KEY } = await import("./statusline.ts");
const { ADOPTED_OPTION } = await import("./updater.ts");

const root = mkdtempSync(join(tmpdir(), "tmux-ide-unadopt-"));
const socket = join(root, "s");
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMUX: "" },
  });
const rootKeys = () => tmux("list-keys", "-T", "root");
const previousTmux = process.env.TMUX;

beforeAll(() => {
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "web", "exec sleep 600");
  tmux("new-session", "-d", "-s", "api", "exec sleep 600");
  process.env.TMUX = `${socket},0,0`;
});
afterAll(() => {
  if (previousTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = previousTmux;
  try {
    tmux("kill-server");
  } catch {
    // already gone
  }
  rmSync(root, { recursive: true, force: true });
});

describe("unadopting one of two adopted sessions on a server", () => {
  it("keeps the server-wide binds until the last adopted session goes", () => {
    // The key alone: tmux also has MouseDown1StatusLeft/Right by default.
    const clickKey = new RegExp(`-T root\\s+${STATUS_CLICK_KEY}\\s`, "u");
    adoptSession("web");
    adoptSession("api");
    expect(rootKeys()).toMatch(clickKey);
    const before = rootKeys().split("\n").length;

    unadoptSession("web");
    expect(tmux("show-options", "-t", "web")).not.toContain(ADOPTED_OPTION);
    expect(tmux("show-options", "-t", "api")).toContain(ADOPTED_OPTION);
    expect(rootKeys()).toMatch(clickKey);
    expect(rootKeys().split("\n").length).toBe(before);

    unadoptSession("api");
    expect(rootKeys()).not.toMatch(clickKey);
  });
});
