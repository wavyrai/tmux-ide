import type { Metadata } from "next";
import Link from "next/link";

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
import {
  GALLERY_PRESETS,
  presetConfigLine,
  type ThemeAppearance,
} from "@/components/themes-gallery/presets";
import { ThemeCard } from "@/components/themes-gallery/theme-card";
import { APP_COMMAND, INSTALL_COMMAND, SITE_IMAGE, SITE_NAME, absoluteUrl } from "@/lib/site";

const PATH = "/themes";
const TITLE = `tmux themes: ${GALLERY_PRESETS.length} light and dark themes for tmux-ide`;
const DESCRIPTION =
  "Light and dark themes for the tmux-ide app, shown in the real app with the one line that selects each. Install tmux-ide with one command.";

// A page's openGraph replaces the layout's whole object, so og:url, the site
// name and the share image are set here together.
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: SITE_NAME,
    url: absoluteUrl(PATH),
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: SITE_IMAGE, width: 1200, height: 630, alt: TITLE }],
  },
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

const presetsFor = (appearance: ThemeAppearance) =>
  GALLERY_PRESETS.filter((preset) => preset.appearance === appearance);

export default function ThemesPage() {
  return (
    <MarketingFrame id="main-content" tabIndex={-1}>
      <Stretch ground="paper">
        <Band>
          <BandBody className="pb-12 pt-12! md:pb-16 md:pt-16!">
            <div className="mx-auto flex max-w-[58rem] flex-col items-center text-center">
              <p className="type-subheadline text-fd-muted-foreground">
                {GALLERY_PRESETS.length} themes · {presetsFor("light").length} light ·{" "}
                {presetsFor("dark").length} dark
              </p>
              <h1 className="type-hero-title mt-4 text-hero-ink">tmux themes</h1>
              <p className="type-hero-lede mt-6 max-w-[58ch] text-hero-body">
                These themes are for the tmux-ide app, which runs on your tmux sessions. A theme
                colors the app&apos;s Home, sidebar, pane headers and terminal panes; a plain tmux
                client attached to the same session keeps its own colors.
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
                    {presetsFor(section.appearance).length}) ↓
                  </Link>
                ))}
              </nav>
              <p className="type-caption-1 mt-4 text-fd-muted-foreground">
                Each card shows the app&apos;s Terminals view, drawn by the app&apos;s own interface
                code, with sample agent panes. Select an image for the full-size view.
              </p>
              <p data-credit="gloomberb" className="type-caption-1 mt-2 text-fd-muted-foreground">
                The theme palettes are adapted from{" "}
                <a
                  href="https://github.com/gloom-sh/gloomberb"
                  className="marketing-link-action text-fd-foreground"
                >
                  Gloomberb
                </a>
                , MIT License, Copyright (c) 2026 Gloomberb Contributors.
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
                  eyebrow={`${presetsFor(section.appearance).length} themes`}
                  title={section.title}
                  description={section.description}
                />
              </div>
              <Mosaic bleed className="mt-12 md:grid-cols-2 lg:grid-cols-3">
                {presetsFor(section.appearance).map((preset) => (
                  <ThemeCard key={preset.id} preset={preset} />
                ))}
                <Cell
                  ground="raise"
                  className="flex h-full flex-col justify-end p-7 md:col-span-2 md:p-9"
                >
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
              description="The Appearance picker saves your choice to ~/.tmux-ide/config.json. To set a theme without the picker, put its preset id in the theme block of that file, next to your other settings. An unknown id is ignored."
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
  );
}
