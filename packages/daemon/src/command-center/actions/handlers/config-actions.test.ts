import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  configAddPaneHandler,
  configAddRowHandler,
  configEnableTeamHandler,
  configRemovePaneHandler,
  configSetHandler,
} from "./config-actions.ts";

let dir: string;
let broadcasts: string[];

function writeIdeYml(config: unknown): void {
  writeFileSync(join(dir, "ide.yml"), yaml.dump(config, { lineWidth: -1, noRefs: true }));
}

function readIdeYml(): { team?: unknown } {
  return yaml.load(readFileSync(join(dir, "ide.yml"), "utf-8")) as { team?: unknown };
}

function readWorkspaceYml(): { name?: string; terminal?: { rows?: { panes?: unknown[] }[] } } {
  return yaml.load(readFileSync(join(dir, ".tmux-ide", "workspace.yml"), "utf-8")) as {
    name?: string;
    terminal?: { rows?: { panes?: unknown[] }[] };
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-config-actions-"));
  broadcasts = [];
  writeIdeYml({ name: "demo", rows: [{ panes: [{ title: "Claude", command: "claude" }] }] });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config actions", () => {
  it("mutates config through workspace projection helpers", async () => {
    const deps = {
      cwd: dir,
      broadcastConfigChanged: (sessionName: string) => broadcasts.push(sessionName),
    };

    expect((await configSetHandler({ path: "name", value: "renamed" }, deps)).config.name).toBe(
      "renamed",
    );
    expect(
      (await configAddPaneHandler({ rowIndex: 0, title: "Tests", command: "pnpm test" }, deps))
        .config.rows[0]?.panes[1]?.title,
    ).toBe("Tests");
    expect(
      (await configRemovePaneHandler({ rowIndex: 0, paneIndex: 1 }, deps)).config.rows[0]?.panes,
    ).toHaveLength(1);
    expect((await configAddRowHandler({ size: "30%" }, deps)).config.rows).toHaveLength(2);
    await expect(configEnableTeamHandler({ name: "team" }, deps)).rejects.toThrow(
      /legacy-only fields/,
    );
    expect(broadcasts.length).toBe(4);
    expect(readIdeYml().team).toBeUndefined();
    expect(readWorkspaceYml().name).toBe("renamed");
  });

  it("raises config_missing when no config exists", async () => {
    rmSync(join(dir, "ide.yml"));
    await expect(configSetHandler({ path: "name", value: "x" }, { cwd: dir })).rejects.toThrow(
      /workspace config was not found/,
    );
  });

  it("raises config_path_invalid for invalid paths", async () => {
    await expect(
      configSetHandler({ path: "rows..title", value: "x" }, { cwd: dir }),
    ).rejects.toThrow(/Invalid config path/);
  });

  it("mutates the winning nested config instead of writing at the git root", async () => {
    rmSync(join(dir, "ide.yml"));
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const app = join(dir, "apps", "web");
    const nested = join(app, "src");
    mkdirSync(join(app, ".tmux-ide"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(app, ".tmux-ide", "workspace.yml"),
      "version: 1\nname: web\nterminal:\n  rows:\n    - panes:\n        - title: Shell\n",
    );

    await configSetHandler({ path: "name", value: "renamed" }, { cwd: nested });

    const saved = yaml.load(readFileSync(join(app, ".tmux-ide", "workspace.yml"), "utf-8")) as {
      name?: string;
    };
    expect(saved.name).toBe("renamed");
    expect(existsSync(join(dir, ".tmux-ide", "workspace.yml"))).toBe(false);
  });
});
