import { describe, expect, it } from "vitest";
import {
  APPLICATION_SHELL_COMMAND_DESCRIPTORS,
  applicationShellActionTraceV1,
  applicationShellCommandDescriptor,
  projectApplicationShellV1,
} from "../application-shell.ts";
import { COHESION_FIXTURE_V1 } from "../cohesion-fixture.ts";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellCommandIdSchemaZ,
  CommandDescriptorSchemaZ,
  CommandInvocationSchemaZ,
} from "../commands.ts";
import { CANONICAL_SURFACE_REGISTRY } from "../experience-shell.ts";

const serialized = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("semantic application shell", () => {
  it("projects navigation and dock identity only from the canonical surface registry", () => {
    const projection = projectApplicationShellV1(COHESION_FIXTURE_V1);
    const projectedSurfaces = [
      ...projection.primaryNavigation.items,
      ...projection.bottomDock.tools,
    ];

    expect(
      projectedSurfaces.map(
        ({ id, icon, label, kind, area, order, owningMode, shortcut, activation }) => ({
          id,
          icon,
          label,
          kind,
          area,
          order,
          owningMode,
          shortcut,
          activation,
        }),
      ),
    ).toEqual(CANONICAL_SURFACE_REGISTRY);
    expect(projection.primaryNavigation.items.map(({ id }) => id)).toEqual(["home", "terminals"]);
    expect(projection.bottomDock.tools.map(({ id }) => id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(
      projection.primaryNavigation.items.every(({ area }) => area === "workspace-canvas"),
    ).toBe(true);
    expect(projection.bottomDock.tools.every(({ area }) => area === "bottom-dock")).toBe(true);
    expect(projection.primaryNavigation.activeMode).toBe("terminals");
    expect(projection.bottomDock).toEqual(
      expect.objectContaining({ mode: "open", activeTool: "missions" }),
    );
    expect(projection.focus.palette).toEqual({
      open: true,
      overlayId: "overlay.palette",
      focusReturnTarget: {
        kind: "pane",
        paneId: "pane.implementer",
        input: "terminal",
      },
    });
  });

  it("round-trips and freezes the host-neutral projection without geometry", () => {
    const projection = projectApplicationShellV1(COHESION_FIXTURE_V1);
    expect(serialized(projection)).toEqual(projection);

    const forbiddenKeys = new Set([
      "x",
      "y",
      "width",
      "height",
      "rect",
      "bounds",
      "cell",
      "cells",
      "column",
      "columns",
      "row",
      "rows",
      "pixel",
      "pixels",
      "px",
      "geometry",
      "tmuxPaneId",
      "ptyId",
      "nativeHandle",
    ]);
    const findings: string[] = [];
    const mutable: string[] = [];
    const walk = (value: unknown, path = "projection"): void => {
      if (!value || typeof value !== "object") return;
      if (!Object.isFrozen(value)) mutable.push(path);
      if (Array.isArray(value)) {
        value.forEach((child, index) => walk(child, `${path}.${index}`));
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) findings.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    };
    walk(projection);

    expect(findings).toEqual([]);
    expect(mutable).toEqual([]);
  });

  it("exports serializable descriptors for every semantic shell command", () => {
    expect(APPLICATION_SHELL_COMMAND_DESCRIPTORS.map(({ id }) => id)).toEqual(
      Object.values(APPLICATION_SHELL_COMMAND_IDS),
    );
    for (const descriptor of APPLICATION_SHELL_COMMAND_DESCRIPTORS) {
      expect(CommandDescriptorSchemaZ.parse(serialized(descriptor))).toEqual(descriptor);
      expect(
        applicationShellCommandDescriptor(ApplicationShellCommandIdSchemaZ.parse(descriptor.id)),
      ).toBe(descriptor);
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.schemas)).toBe(true);
    }
  });

  it("turns the shared cohesion fixture into one exact cross-host command trace", () => {
    const trace = applicationShellActionTraceV1(COHESION_FIXTURE_V1);
    expect(trace.invocations.map(({ id, args }) => ({ id, args }))).toEqual([
      { id: "workspace.mode.activate", args: { mode: "home" } },
      { id: "workspace.mode.activate", args: { mode: "terminals" } },
      { id: "workspace.mode.activate", args: { mode: "terminals" } },
      { id: "workspace.dock.mode.set", args: { mode: "open" } },
      { id: "workspace.dock.activate", args: { tool: "files" } },
      { id: "workspace.mode.activate", args: { mode: "terminals" } },
      { id: "workspace.dock.mode.set", args: { mode: "open" } },
      { id: "workspace.dock.activate", args: { tool: "changes" } },
      { id: "workspace.mode.activate", args: { mode: "terminals" } },
      { id: "workspace.dock.mode.set", args: { mode: "open" } },
      { id: "workspace.dock.activate", args: { tool: "missions" } },
      { id: "workspace.mode.activate", args: { mode: "terminals" } },
      { id: "workspace.dock.mode.set", args: { mode: "open" } },
      { id: "workspace.dock.activate", args: { tool: "activity" } },
      { id: "workspace.dock.mode.set", args: { mode: "collapsed" } },
      { id: "workspace.dock.mode.set", args: { mode: "open" } },
      { id: "workspace.dock.mode.set", args: { mode: "maximized" } },
      {
        id: "workspace.focus.move",
        args: { target: { kind: "zone", zone: "dock-tabs" } },
      },
      {
        id: "app.palette.open",
        args: {
          overlayId: "overlay.palette",
          focusReturnTarget: {
            kind: "pane",
            paneId: "pane.implementer",
            input: "terminal",
          },
        },
      },
      { id: "app.palette.close", args: { overlayId: "overlay.palette" } },
      {
        id: "workspace.focus.move",
        args: {
          target: { kind: "pane", paneId: "pane.implementer", input: "terminal" },
        },
      },
    ]);
    expect(serialized(trace)).toEqual(trace);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.invocations)).toBe(true);
    for (const invocation of trace.invocations) {
      expect(CommandInvocationSchemaZ.parse(serialized(invocation))).toEqual(invocation);
      expect(
        applicationShellCommandDescriptor(ApplicationShellCommandIdSchemaZ.parse(invocation.id)),
      ).toBeDefined();
      expect(invocation.source).toEqual({ kind: "program", surface: "application-shell" });
    }
  });
});
