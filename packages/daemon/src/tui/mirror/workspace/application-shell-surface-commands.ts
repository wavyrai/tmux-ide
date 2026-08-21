import {
  APPLICATION_SHELL_COMMAND_IDS,
  applicationShellCommandInvocation,
  commandsToOpenSurface,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionV1,
  type CommandSource,
  type ProductSurfaceId,
  type SemanticFocusTarget,
} from "@tmux-ide/contracts";

export const APPLICATION_SHELL_PALETTE_OVERLAY_ID = "overlay.command-palette";

/** Canonical surface activation plus its explicit semantic focus move. */
export function applicationShellSurfaceInvocations(
  projection: ApplicationShellProjectionV1,
  surfaceId: ProductSurfaceId,
  source: CommandSource,
): readonly ApplicationShellCommandInvocation[] {
  const surface = [...projection.primaryNavigation.items, ...projection.bottomDock.tools].find(
    ({ id }) => id === surfaceId,
  );
  if (!surface) throw new Error(`unknown canonical application surface: ${surfaceId}`);
  const open = commandsToOpenSurface({ surface: surfaceId }).map((command) =>
    applicationShellCommandInvocation(command.id, command.args, source),
  );
  return [
    ...open,
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      {
        target:
          surface.kind === "primary-mode"
            ? { kind: "zone", zone: "canvas" }
            : { kind: "zone", zone: "dock-body" },
      },
      source,
    ),
  ];
}

export function applicationShellPaletteInvocation(
  projection: ApplicationShellProjectionV1,
  open: boolean,
  source: CommandSource,
): ApplicationShellCommandInvocation {
  if (open) {
    const target: SemanticFocusTarget = projection.focus.terminalInputPaneId
      ? { kind: "pane", paneId: projection.focus.terminalInputPaneId, input: "terminal" }
      : projection.focus.zone === "dock-tabs" || projection.focus.zone === "dock-body"
        ? { kind: "dock-tool", tool: projection.bottomDock.activeTool }
        : { kind: "zone", zone: projection.focus.zone };
    return applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.openPalette,
      { overlayId: APPLICATION_SHELL_PALETTE_OVERLAY_ID, focusReturnTarget: target },
      source,
    );
  }
  return applicationShellCommandInvocation(
    APPLICATION_SHELL_COMMAND_IDS.closePalette,
    { overlayId: projection.focus.palette.overlayId ?? APPLICATION_SHELL_PALETTE_OVERLAY_ID },
    source,
  );
}
