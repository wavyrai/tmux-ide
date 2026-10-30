import Image from "next/image";

import { CopyButton } from "@/app/(home)/copy-button";
import { Cell } from "@/components/marketing/lattice";

import { presetConfigLine, SWATCH_ROLES, THUMB_SIZE, type GalleryPreset } from "./presets";

/**
 * One gallery card: the app rendered in the preset (linked to its full-size
 * render), its name, light or dark, its palette, the line that selects it, and
 * the source scheme's attribution when the palette is adapted from one.
 */
export function ThemeCard({ preset }: { preset: GalleryPreset }) {
  const line = presetConfigLine(preset.id);
  const appearance = preset.appearance === "light" ? "Light" : "Dark";
  return (
    <Cell ground="paper" className="flex h-full flex-col">
      <article id={preset.id} aria-labelledby={`${preset.id}-name`} className="scroll-mt-28">
        <a href={preset.full} tabIndex={-1} aria-hidden className="block">
          <Image
            src={preset.thumb}
            alt={`The tmux-ide app in the ${preset.name} theme (${preset.appearance})`}
            width={THUMB_SIZE.width}
            height={THUMB_SIZE.height}
            sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
            unoptimized
            loading="lazy"
            className="block h-auto w-full border-b border-marketing-line"
          />
        </a>
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-baseline justify-between gap-4">
            <h3 id={`${preset.id}-name`} className="type-card-title text-fd-foreground">
              {preset.name}
            </h3>
            <span className="type-caption-1 text-fd-muted-foreground">{appearance}</span>
          </div>
          <ul aria-label={`${preset.name} palette`} className="flex gap-1.5">
            {SWATCH_ROLES.map((role) => (
              <li
                key={role}
                title={`${role} ${preset.swatches[role]}`}
                className="h-4 flex-1 border border-marketing-line"
                style={{ backgroundColor: preset.swatches[role] }}
              >
                <span className="sr-only">
                  {role} {preset.swatches[role]}
                </span>
              </li>
            ))}
          </ul>
          <CopyButton
            text={line}
            label={`Copy the theme setting for ${preset.name}`}
            announcement="Theme setting copied to clipboard."
            failedAnnouncement="Could not copy the theme setting. Select it and copy it manually."
            className="type-caption-1 flex w-full cursor-pointer items-center gap-3 border border-marketing-line bg-marketing-panel px-3 py-2 text-left"
          >
            <code className="min-w-0 break-all font-mono text-fd-foreground">{line}</code>
            <span className="install-box-copy">Copy</span>
          </CopyButton>
          <div className="type-caption-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 text-fd-muted-foreground">
            {preset.attribution ? (
              <span data-attribution={preset.id}>
                Palette adapted from{" "}
                <a
                  href={preset.attribution.url}
                  className="marketing-link-action text-fd-foreground"
                >
                  {preset.attribution.scheme}
                </a>
                , {preset.attribution.licence}
              </span>
            ) : null}
            <a
              href={preset.full}
              className="marketing-link-action ml-auto shrink-0 text-fd-primary"
            >
              Full size<span className="sr-only">: {preset.name}</span> ↗
            </a>
          </div>
        </div>
      </article>
    </Cell>
  );
}
