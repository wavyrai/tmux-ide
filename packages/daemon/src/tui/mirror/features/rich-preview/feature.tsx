/* @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";

import type { SemanticThemeSnapshot } from "../../theme.ts";
export { TuiRichWidgetSurface } from "../../widget-surface.tsx";
export type { TuiRichWidgetSurfaceProps } from "../../widget-surface.tsx";
import type {
  RichPreviewHost,
  RichPreviewPublication,
  RichPreviewRequest,
  RichPreviewSessionMetrics,
} from "./contract.ts";
import { createRichPreviewSession, type RichPreviewSessionOptions } from "./session.ts";

export interface RichPreviewFeatureHost extends RichPreviewHost {
  readonly theme: () => SemanticThemeSnapshot;
}

export interface RichPreviewFeatureSession {
  readonly sync: (requests: readonly RichPreviewRequest[]) => void;
  readonly publications: () => readonly RichPreviewPublication[];
  readonly syntaxStyle: () => SyntaxStyle | null;
  readonly syncTheme: () => void;
  readonly getMetrics: () => RichPreviewSessionMetrics;
  readonly dispose: () => void;
}

function createMarkdownSyntaxStyle(theme: SemanticThemeSnapshot): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.roles.text.primary },
    "markup.heading": { fg: theme.colors.accent, bold: true },
    "markup.strong": { fg: theme.roles.text.primary, bold: true },
    "markup.italic": { fg: theme.roles.text.secondary, italic: true },
    "markup.raw": { fg: theme.roles.text.primary, bg: theme.roles.surfaces.headerActive },
    "markup.raw.block": { fg: theme.roles.text.primary, bg: theme.roles.surfaces.headerActive },
    "markup.link": { fg: theme.colors.accent, underline: true },
    "markup.link.label": { fg: theme.colors.accent, underline: true },
    "markup.link.url": { fg: theme.roles.text.secondary, underline: true },
    "markup.quote": { fg: theme.roles.text.secondary, italic: true },
    "markup.list": { fg: theme.colors.accent },
  });
}

/** Deferred OpenTUI-specific owner for Markdown syntax resources. */
export function createRichPreviewFeatureSession(
  host: RichPreviewFeatureHost,
  options: RichPreviewSessionOptions = {},
): RichPreviewFeatureSession {
  let session!: ReturnType<typeof createRichPreviewSession>;
  let style: SyntaxStyle | null = null;
  let theme = host.theme();
  let disposed = false;
  let frameGeneration = 0;
  const retiredStyles = new Set<SyntaxStyle>();

  const hasResolvedMarkdown = (): boolean =>
    session
      .publications()
      .some(
        ({ resolution }) => resolution.phase === "ready" && resolution.surface.kind === "markdown",
      );

  const replaceStyle = (next: SyntaxStyle | null): boolean => {
    const previous = style;
    if (previous === next) return false;
    style = next;
    const generation = ++frameGeneration;
    if (previous) {
      retiredStyles.add(previous);
      host.afterNativeFrame(() => {
        // Replacement was already published before this committed frame. Even
        // if another theme lands meanwhile, each retired native resource is
        // destroyed exactly once after a safe renderer boundary.
        if (generation <= frameGeneration && retiredStyles.delete(previous)) previous.destroy();
      });
    }
    return true;
  };

  const reconcileStyle = (): boolean => {
    if (disposed) return false;
    if (!hasResolvedMarkdown()) {
      return replaceStyle(null);
    }
    const nextTheme = host.theme();
    if (!style || nextTheme !== theme) {
      theme = nextTheme;
      return replaceStyle(createMarkdownSyntaxStyle(nextTheme));
    }
    return false;
  };

  session = createRichPreviewSession(
    {
      ...host,
      onChange: () => {
        reconcileStyle();
        host.onChange();
      },
    },
    options,
  );

  return {
    sync(requests): void {
      session.sync(requests);
      if (reconcileStyle()) host.onChange();
    },
    publications(): readonly RichPreviewPublication[] {
      return session.publications();
    },
    syntaxStyle: () => style,
    syncTheme(): void {
      if (reconcileStyle()) host.onChange();
    },
    getMetrics: () => session.getMetrics(),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      frameGeneration += 1;
      session.dispose();
      const previous = style;
      style = null;
      if (previous) {
        retiredStyles.add(previous);
        host.afterNativeFrame(() => {
          if (retiredStyles.delete(previous)) previous.destroy();
        });
      }
    },
  };
}

export { createRichPreviewAssetLoader } from "./asset-loader.ts";
export {
  createRichPreviewSession,
  richPreviewRequestsFromCanonical,
  RICH_PREVIEW_RETAINED_BYTE_CAP,
} from "./session.ts";
export type { RichPreviewCanonicalSource, RichPreviewSessionOptions } from "./session.ts";
export type * from "./contract.ts";
