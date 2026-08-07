import { describe, expect, it } from "vitest";

import {
  EXPERIMENTAL_DOCK_TOOLS,
  EXPERIMENTAL_SURFACES_FLAG,
  hiddenDockTools,
  readExperimentalSurfacesEnabled,
} from "./experimental-surfaces.ts";

function storage(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: () => value };
}

describe("experimental surfaces flag", () => {
  it("withholds Missions and Activity until something turns them on", () => {
    // The GUI-first scope call: a fresh install shows terminals, files and
    // changes. A regression here silently ships the parked surfaces.
    expect(readExperimentalSurfacesEnabled()).toBe(false);
    expect([...hiddenDockTools(false)]).toEqual([...EXPERIMENTAL_DOCK_TOOLS]);
    expect([...hiddenDockTools(true)]).toEqual([]);
  });

  it("reads the flag from the URL, then from storage", () => {
    expect(readExperimentalSurfacesEnabled({ search: `?${EXPERIMENTAL_SURFACES_FLAG}=1` })).toBe(
      true,
    );
    expect(readExperimentalSurfacesEnabled({ storage: storage("true") })).toBe(true);
    // The URL is the narrower scope, so it decides — one window can differ from
    // the setting every other window reads.
    expect(
      readExperimentalSurfacesEnabled({
        search: `?${EXPERIMENTAL_SURFACES_FLAG}=0`,
        storage: storage("1"),
      }),
    ).toBe(false);
  });

  it("treats an unreadable or unrecognised setting as absent rather than as a vote", () => {
    expect(
      readExperimentalSurfacesEnabled({
        search: `?${EXPERIMENTAL_SURFACES_FLAG}=maybe`,
        storage: storage("1"),
      }),
    ).toBe(true);
    expect(readExperimentalSurfacesEnabled({ storage: storage("maybe") })).toBe(false);
    expect(
      readExperimentalSurfacesEnabled({
        storage: {
          getItem: () => {
            throw new Error("storage is denied in this context");
          },
        },
      }),
    ).toBe(false);
  });
});
