import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  configAddPaneHandler,
  configAddRowHandler,
  configDisableTeamHandler,
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-config-actions-"));
  broadcasts = [];
  writeIdeYml({ name: "demo", rows: [{ panes: [{ title: "Claude", command: "claude" }] }] });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config actions", () => {
  it("mutates ide.yml through config helpers", () => {
    const deps = {
      cwd: dir,
      broadcastConfigChanged: (sessionName: string) => broadcasts.push(sessionName),
    };

    expect(configSetHandler({ path: "name", value: "renamed" }, deps).config.name).toBe("renamed");
    expect(
      configAddPaneHandler({ rowIndex: 0, title: "Tests", command: "pnpm test" }, deps).config
        .rows[0]?.panes[1]?.title,
    ).toBe("Tests");
    expect(
      configRemovePaneHandler({ rowIndex: 0, paneIndex: 1 }, deps).config.rows[0]?.panes,
    ).toHaveLength(1);
    expect(configAddRowHandler({ size: "30%" }, deps).config.rows).toHaveLength(2);
    expect(configEnableTeamHandler({ name: "team" }, deps).config.team?.name).toBe("team");
    expect(configDisableTeamHandler({}, deps).config.team).toBeUndefined();
    expect(broadcasts.length).toBe(6);
    expect(readIdeYml().team).toBeUndefined();
  });

  it("raises ide_yml_missing when no config exists", () => {
    rmSync(join(dir, "ide.yml"));
    expect(() => configSetHandler({ path: "name", value: "x" }, { cwd: dir })).toThrow(
      /ide.yml was not found/,
    );
  });

  it("raises config_path_invalid for invalid paths", () => {
    expect(() => configSetHandler({ path: "rows..title", value: "x" }, { cwd: dir })).toThrow(
      /Invalid config path/,
    );
  });
});
