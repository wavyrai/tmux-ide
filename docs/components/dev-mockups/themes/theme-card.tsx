import Image from "next/image";

import { CopyButton } from "@/app/(home)/copy-button";
import { Cell } from "@/components/marketing/lattice";

import { presetConfigLine, SWATCH_ROLES, type ThemePreset } from "./presets";
import { THEME_RENDERS } from "./renders";

/** One gallery card: the app rendered in the preset, its name, and the line that selects it. */
export function ThemeCard({ preset }: { preset: ThemePreset }) {
  const render = THEME_RENDERS[preset.id];
  const line = presetConfigLine(preset.id);
  return (
    <Cell ground="paper" className="flex h-full flex-col">
      <article id={`theme-${preset.id}`} aria-labelledby={`theme-${preset.id}-name`}>
        {render ? (
          <Image
            src={render}
            alt={`The tmux-ide app in the ${preset.name} theme (${preset.appearance})`}
            sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
            unoptimized
            loading="lazy"
            className="block h-auto w-full border-b border-marketing-line"
          />
        ) : null}
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-baseline justify-between gap-4">
            <h3 id={`theme-${preset.id}-name`} className="type-card-title text-fd-foreground">
              {preset.name}
            </h3>
            <span className="type-caption-1 text-fd-muted-foreground">
              {preset.appearance === "light" ? "Light" : "Dark"}
            </span>
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
            label={`Copy the config line for ${preset.name}`}
            className="type-caption-1 flex w-full cursor-pointer items-center gap-3 border border-marketing-line bg-marketing-panel px-3 py-2 text-left"
          >
            <code className="min-w-0 break-all font-mono text-fd-foreground">{line}</code>
            <span className="install-box-copy">Copy</span>
          </CopyButton>
        </div>
      </article>
    </Cell>
  );
}
