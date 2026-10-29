import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MockupShell } from "@/components/dev-mockups/themes/mockup-shell";
import {
  presetConfigLine,
  THEME_PRESETS,
  type ThemeAppearance,
} from "@/components/dev-mockups/themes/presets";
import { ThemeCard } from "@/components/dev-mockups/themes/theme-card";
import { InstallCommand } from "@/components/marketing/install-tabs";
import {
  Band,
  BandBody,
  Cell,
  MarketingFrame,
  Mosaic,
  Stretch,
} from "@/components/marketing/lattice";
import { SectionHeader } from "@/components/marketing/section-header";
import { APP_COMMAND, INSTALL_COMMAND } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "tmux themes: 22 light and dark themes for tmux-ide" },
  description:
    "A gallery of 22 tmux themes, light and dark, shown in the real tmux-ide app. Install with one line, then switch themes with a live preview.",
  alternates: { canonical: "/dev/themes" },
  robots: { index: false, follow: false },
};

const bodyCopy = "type-marketing-body max-w-[62ch] text-fd-muted-foreground";

const SECTIONS: readonly {
  appearance: ThemeAppearance;
  id: string;
  title: string;
  description: string;
  aside: { title: string; body: string };
}[] = [
  {
    appearance: "light",
    id: "light-themes",
    title: "Light tmux themes",
    description: "Light canvases, from warm paper to cool blue-grey.",
    aside: {
      title: "Or follow your terminal",
      body: "System mode, the default for new settings, reads your terminal's background and picks the app's Light or Dark theme to match.",
    },
  },
  {
    appearance: "dark",
    id: "dark-themes",
    title: "Dark tmux themes",
    description: "Dark canvases, from muted editor palettes to single-color phosphor screens.",
    aside: {
      title: "Text stays readable",
      body: "Automatic contrast is on for every theme. Text that falls under a 4.5:1 contrast ratio against its background is adjusted, inside terminal panes too.",
    },
  },
];

export default function ThemesMockup() {
  if (process.env.VERCEL_ENV === "production") notFound();

  const count = (appearance: ThemeAppearance) =>
    THEME_PRESETS.filter((preset) => preset.appearance === appearance).length;

  return (
    <MockupShell card="#644">
      <MarketingFrame id="main-content" tabIndex={-1}>
        <Stretch ground="paper">
          <Band>
            <BandBody className="pb-12 pt-12! md:pb-16 md:pt-16!">
              <div className="mx-auto flex max-w-[58rem] flex-col items-center text-center">
                <p className="type-subheadline text-fd-muted-foreground">
                  {THEME_PRESETS.length} presets · {count("light")} light · {count("dark")} dark
                </p>
                <h1 className="type-hero-title mt-4 text-hero-ink">tmux themes</h1>
                <p className="type-hero-lede mt-6 max-w-[58ch] text-hero-body">
                  Every theme the tmux-ide app ships, in light and dark. One setting colors Home,
                  the sidebar, pane headers and the terminal panes.
                </p>
                <div className="mt-8 flex w-full flex-col items-center">
                  <InstallCommand command={INSTALL_COMMAND} />
                  <p className="type-body mt-4 text-fd-muted-foreground">
                    Then run <code className="font-mono text-fd-foreground">{APP_COMMAND}</code> and
                    open Commands (<code className="font-mono text-fd-foreground">F5</code>) →
                    Appearance… to preview each theme live.
                  </p>
                </div>
                <nav aria-label="Theme sections" className="type-body mt-8 flex gap-6">
                  {SECTIONS.map((section) => (
                    <Link
                      key={section.id}
                      href={`#${section.id}`}
                      className="marketing-link-action text-fd-primary"
                    >
                      {section.appearance === "light" ? "Light" : "Dark"} themes (
                      {count(section.appearance)}) ↓
                    </Link>
                  ))}
                </nav>
                <p className="type-caption-1 mt-4 text-fd-muted-foreground">
                  Each card shows the app's Terminals view, drawn by the app's own interface code,
                  with sample agent panes.
                </p>
              </div>
            </BandBody>
          </Band>
        </Stretch>

        <Stretch ground="raise">
          {SECTIONS.map((section) => (
            <Band key={section.id}>
              <BandBody>
                <div id={section.id} className="scroll-mt-28">
                  <SectionHeader
                    eyebrow={`${count(section.appearance)} presets`}
                    title={section.title}
                    description={section.description}
                  />
                </div>
                <Mosaic bleed className="mt-12 md:grid-cols-2 lg:grid-cols-3">
                  {THEME_PRESETS.filter((preset) => preset.appearance === section.appearance).map(
                    (preset) => (
                      <ThemeCard key={preset.id} preset={preset} />
                    ),
                  )}
                  <Cell ground="raise" className="flex h-full flex-col justify-end p-7 md:p-9">
                    <h3 className="type-card-title text-fd-foreground">{section.aside.title}</h3>
                    <p className={`mt-4 ${bodyCopy}`}>{section.aside.body}</p>
                  </Cell>
                </Mosaic>
              </BandBody>
            </Band>
          ))}
        </Stretch>

        <Stretch ground="panel">
          <Band rule={false}>
            <BandBody>
              <SectionHeader
                eyebrow="Set it by hand"
                title="One line in your config."
                description="The Appearance picker saves your choice to ~/.tmux-ide/config.json. To set a theme without the picker, add its preset id to the theme block there. An unknown id is ignored."
              />
              <pre className="type-caption-1 mt-8 max-w-2xl overflow-x-auto border border-marketing-line bg-marketing-paper px-4 py-3 font-mono text-fd-foreground">
                <code>{presetConfigLine("tokyo")}</code>
              </pre>
              <p className="type-body mt-6 text-fd-muted-foreground">
                <Link href="/docs/theming" className="marketing-link-action text-fd-primary">
                  Appearance and themes docs →
                </Link>
              </p>
            </BandBody>
          </Band>
        </Stretch>
      </MarketingFrame>
    </MockupShell>
  );
}
