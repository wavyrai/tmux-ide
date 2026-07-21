import { describe, expect, it } from "vitest";
import {
  APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS,
  APPLICATION_SHELL_COMMAND_DEFINITIONS,
  APPLICATION_SHELL_COMMAND_DESCRIPTORS,
  ApplicationShellActionTraceV1SchemaZ,
  ApplicationShellCommandInvocationSchemaZ,
  ApplicationShellProjectionV1SchemaZ,
  applyApplicationShellInvocationV1,
  applicationShellActionTraceV1,
  applicationShellCommandInvocation,
  applicationShellCommandDescriptor,
  projectApplicationShellV1,
  replayApplicationShellActionTraceV1,
} from "../application-shell.ts";
import { COHESION_FIXTURE_V1 } from "../cohesion-fixture.ts";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellCommandIdSchemaZ,
  CommandDescriptorSchemaZ,
  CommandInvocationSchemaZ,
} from "../commands.ts";
import {
  CANONICAL_SHELL_AREAS,
  CANONICAL_SURFACE_REGISTRY,
  commandsToOpenSurface,
} from "../experience-shell.ts";

const serialized = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function mutableDataPaths(value: unknown, path = "value", findings: string[] = []): string[] {
  if (!value || typeof value !== "object") return findings;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    return findings;
  if (!Object.isFrozen(value)) findings.push(path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => mutableDataPaths(child, `${path}.${index}`, findings));
  } else {
    for (const [key, child] of Object.entries(value)) {
      mutableDataPaths(child, `${path}.${key}`, findings);
    }
  }
  return findings;
}

const closedOverlayFixture = {
  ...COHESION_FIXTURE_V1,
  focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
};

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
    expect(ApplicationShellProjectionV1SchemaZ.parse(serialized(projection))).toEqual(projection);

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
    expect(APPLICATION_SHELL_COMMAND_DEFINITIONS.map(({ descriptor }) => descriptor)).toEqual(
      APPLICATION_SHELL_COMMAND_DESCRIPTORS,
    );
    for (const definition of APPLICATION_SHELL_COMMAND_DEFINITIONS) {
      expect(definition.inputSchema).toBe(
        APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS[
          ApplicationShellCommandIdSchemaZ.parse(definition.descriptor.id)
        ],
      );
    }
  });

  it("deep-freezes every exported and returned shell data source", () => {
    const invocation = applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      { target: { kind: "zone", zone: "dock-tabs" } },
      { kind: "keyboard", surface: "workbench" },
    );
    const sources = {
      commandIds: APPLICATION_SHELL_COMMAND_IDS,
      commandSchemas: APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS,
      commandDefinitions: APPLICATION_SHELL_COMMAND_DEFINITIONS,
      shellAreas: CANONICAL_SHELL_AREAS,
      surfaces: CANONICAL_SURFACE_REGISTRY,
      openSurfaceCommands: commandsToOpenSurface({
        surface: "missions",
        resourceId: "mission.m31",
      }),
      descriptors: APPLICATION_SHELL_COMMAND_DESCRIPTORS,
      invocation,
    };
    for (const [name, source] of Object.entries(sources)) {
      expect(mutableDataPaths(source, name), name).toEqual([]);
    }
  });

  it("validates each command's arguments by semantic id", () => {
    const source = { kind: "program", surface: "test" } as const;
    const valid = [
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.activateMode,
        { mode: "home" },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
        { tool: "files" },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode: "open" },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.moveFocus,
        { target: { kind: "zone", zone: "canvas" } },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.openPalette,
        {
          overlayId: "overlay.palette.test",
          focusReturnTarget: { kind: "zone", zone: "canvas" },
        },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.closePalette,
        { overlayId: "overlay.palette.test" },
        source,
      ),
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.selectResource,
        { surface: "files", resourceId: "file.readme" },
        source,
      ),
    ];
    for (const invocation of valid) {
      expect(ApplicationShellCommandInvocationSchemaZ.parse(serialized(invocation))).toEqual(
        invocation,
      );
    }
    expect(() =>
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
        { tool: "unknown" } as never,
        source,
      ),
    ).toThrow();
    expect(
      ApplicationShellCommandInvocationSchemaZ.safeParse({
        ...valid[0],
        args: { tool: "files" },
      }).success,
    ).toBe(false);
  });

  it("turns the shared cohesion fixture into one exact cross-host command trace", () => {
    const trace = applicationShellActionTraceV1(closedOverlayFixture);
    expect(trace.invocations.map(({ id, args }) => ({ id, args }))).toEqual([
      { id: "application.shell.mode.activate", args: { mode: "home" } },
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
      { id: "application.shell.dock.mode.set", args: { mode: "open" } },
      { id: "application.shell.dock.activate", args: { tool: "files" } },
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
      { id: "application.shell.dock.mode.set", args: { mode: "open" } },
      { id: "application.shell.dock.activate", args: { tool: "changes" } },
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
      { id: "application.shell.dock.mode.set", args: { mode: "open" } },
      { id: "application.shell.dock.activate", args: { tool: "missions" } },
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
      { id: "application.shell.dock.mode.set", args: { mode: "open" } },
      { id: "application.shell.dock.activate", args: { tool: "activity" } },
      { id: "application.shell.dock.mode.set", args: { mode: "collapsed" } },
      { id: "application.shell.dock.mode.set", args: { mode: "open" } },
      { id: "application.shell.dock.mode.set", args: { mode: "maximized" } },
      {
        id: "application.shell.focus.move",
        args: { target: { kind: "zone", zone: "dock-tabs" } },
      },
      {
        id: "application.shell.palette.open",
        args: {
          overlayId: "overlay.palette.trace",
          focusReturnTarget: { kind: "zone", zone: "dock-tabs" },
        },
      },
      {
        id: "application.shell.palette.close",
        args: { overlayId: "overlay.palette.trace" },
      },
    ]);
    expect(serialized(trace)).toEqual(trace);
    expect(ApplicationShellActionTraceV1SchemaZ.parse(serialized(trace))).toEqual(trace);
    expect(mutableDataPaths(trace, "trace")).toEqual([]);
    for (const invocation of trace.invocations) {
      expect(CommandInvocationSchemaZ.parse(serialized(invocation))).toEqual(invocation);
      expect(
        applicationShellCommandDescriptor(ApplicationShellCommandIdSchemaZ.parse(invocation.id)),
      ).toBeDefined();
      expect(invocation.source).toEqual({ kind: "program", surface: "application-shell" });
    }
    expect(replayApplicationShellActionTraceV1(trace)).toEqual(trace.finalState);
    expect(trace.finalState.focus).toMatchObject({
      focusZone: "dock-tabs",
      terminalInputPaneId: null,
      overlays: [],
    });
  });

  it("replays palette ownership sequentially and restores the pre-overlay focus", () => {
    const trace = applicationShellActionTraceV1(closedOverlayFixture);
    const openIndex = trace.invocations.findIndex(
      ({ id }) => id === APPLICATION_SHELL_COMMAND_IDS.openPalette,
    );
    const beforeOpen = trace.invocations
      .slice(0, openIndex)
      .reduce(
        (state, invocation) => applyApplicationShellInvocationV1(state, invocation),
        trace.initialState,
      );
    const opened = applyApplicationShellInvocationV1(beforeOpen, trace.invocations[openIndex]!);
    expect(opened.focus.overlays).toHaveLength(1);
    expect(() =>
      applyApplicationShellInvocationV1(
        opened,
        applicationShellCommandInvocation(
          APPLICATION_SHELL_COMMAND_IDS.activateMode,
          { mode: "home" },
          { kind: "program" },
        ),
      ),
    ).toThrow("semantic input is owned by overlay");
    const closed = applyApplicationShellInvocationV1(opened, trace.invocations[openIndex + 1]!);
    expect(closed.focus).toEqual(beforeOpen.focus);
    expect(() => applicationShellActionTraceV1(COHESION_FIXTURE_V1)).toThrow(
      "closed-overlay initial state",
    );

    const tampered = serialized(trace);
    tampered.finalState.activeMode = "home";
    expect(ApplicationShellActionTraceV1SchemaZ.safeParse(tampered).success).toBe(false);
  });
});
