import { Folder01Icon } from "@hugeicons/core-free-icons";
import { Show, mergeProps, type JSX } from "solid-js";

import { Icon, resolveIconSize, type IconSizeName } from "./icon.tsx";

/**
 * The visual identity for a workspace or session, resolved in one place.
 *
 * Resolution order is deliberate and total — there is always a glyph, so a row
 * never falls back to a bare label:
 *
 *   1. an emoji the user chose
 *   2. a color, drawn as a filled dot
 *   3. the folder glyph
 *
 * Used by the fleet sidebar rows and the window title chrome, so a workspace
 * looks the same everywhere it appears.
 */
export interface WorkspaceIdentityProps {
  /** A single emoji chosen for this workspace. */
  readonly emoji?: string;
  /** Any CSS color. Used only when there is no emoji. */
  readonly color?: string;
  readonly size?: number | IconSizeName;
  readonly class?: string;
}

/** The dot is smaller than the box so it reads as a mark, not a fill. */
const DOT_RATIO = 0.6;
const DOT_MINIMUM = 8;

export function workspaceIdentityDotSize(size: number): number {
  return Math.max(DOT_MINIMUM, Math.round(size * DOT_RATIO));
}

export function WorkspaceIdentity(props: WorkspaceIdentityProps): JSX.Element {
  const merged = mergeProps({ size: "dense" as number | IconSizeName }, props);
  const size = () => resolveIconSize(merged.size);

  return (
    <Show
      when={merged.emoji}
      fallback={
        <Show
          when={merged.color}
          fallback={
            <Icon
              icon={Folder01Icon}
              size={merged.size}
              class={`tmi-workspace-identity${merged.class ? ` ${merged.class}` : ""}`}
            />
          }
        >
          {(color) => (
            <span
              aria-hidden="true"
              class={`tmi-workspace-identity tmi-workspace-identity--dot${
                merged.class ? ` ${merged.class}` : ""
              }`}
              style={{
                "background-color": color(),
                width: `${workspaceIdentityDotSize(size())}px`,
                height: `${workspaceIdentityDotSize(size())}px`,
              }}
            />
          )}
        </Show>
      }
    >
      {(emoji) => (
        <span
          aria-hidden="true"
          class={`tmi-workspace-identity tmi-workspace-identity--emoji${
            merged.class ? ` ${merged.class}` : ""
          }`}
          style={{ "font-size": `${size()}px`, width: `${size()}px`, height: `${size()}px` }}
        >
          {emoji()}
        </span>
      )}
    </Show>
  );
}
