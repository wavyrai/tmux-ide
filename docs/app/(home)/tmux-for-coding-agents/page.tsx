import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { AgentSectionBand } from "@/components/agents-page/agent-section";
import { AGENT_SECTIONS, AGENTS_PAGE } from "@/components/agents-page/content";
import { InstallCommand } from "@/components/marketing/install-tabs";
import { Band, BandBody, MarketingFrame, Stretch } from "@/components/marketing/lattice";
import { SectionHeader } from "@/components/marketing/section-header";
import { TechnicalCaption } from "@/components/marketing/technical-caption";
import { TuiHeroCursors } from "@/components/marketing/tui-cursor";
import tuiDemoSize from "@/components/marketing/tui-demo-size.json";
import { APP_COMMAND, INSTALL_COMMAND, SITE_IMAGE, SITE_NAME, absoluteUrl } from "@/lib/site";

const pageUrl = absoluteUrl(AGENTS_PAGE.path);

export const metadata: Metadata = {
  title: { absolute: AGENTS_PAGE.title },
  description: AGENTS_PAGE.description,
  alternates: { canonical: AGENTS_PAGE.path },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: SITE_NAME,
    url: pageUrl,
    title: AGENTS_PAGE.title,
    description: AGENTS_PAGE.description,
    images: [{ url: SITE_IMAGE, width: 1200, height: 630, alt: AGENTS_PAGE.title }],
  },
  twitter: {
    card: "summary_large_image",
    creator: "@prototyper_co",
    site: "@prototyper_co",
    title: AGENTS_PAGE.title,
    description: AGENTS_PAGE.description,
    images: [SITE_IMAGE],
  },
};

const demoAlt =
  "Animated tmux-ide app showing agent status, terminal panes, window controls, and Commands";

const dot = (
  <span aria-hidden className="mx-3">
    ·
  </span>
);

export default function TmuxForCodingAgentsPage() {
  return (
    <MarketingFrame id="main-content" tabIndex={-1}>
      <Stretch ground="paper">
        <Band>
          <BandBody className="pb-12 pt-12! md:pb-16 md:pt-16!">
            <div className="mx-auto flex max-w-[58rem] flex-col items-center text-center">
              <p className="type-subheadline text-fd-muted-foreground">{AGENTS_PAGE.eyebrow}</p>
              <h1 className="type-hero-title mt-4 text-hero-ink">tmux for coding agents</h1>
              <p className="type-hero-lede mt-6 max-w-[58ch] text-hero-body">{AGENTS_PAGE.lede}</p>
              <div className="mt-8 flex w-full flex-col items-center">
                <InstallCommand command={INSTALL_COMMAND} />
                <p className="type-body mt-4 text-fd-muted-foreground">
                  Then run <code className="font-mono text-fd-foreground">{APP_COMMAND}</code>
                  {dot}
                  macOS and glibc Linux, no sudo
                  {dot}
                  <Link
                    href="/docs/getting-started"
                    className="marketing-link-action text-fd-foreground"
                  >
                    Read the guide →
                  </Link>
                </p>
              </div>
            </div>
          </BandBody>
          {/* Below 640px the full app is too small to read; the sections' own
              figures carry the page there. */}
          <figure id="figure-01" aria-labelledby="figure-01-caption" className="max-sm:hidden">
            <div className="border-y border-marketing-line bg-terminal-stage p-2 md:p-4">
              <div className="relative border border-terminal-line bg-terminal-stage">
                <Image
                  src="/tui-demo-light.svg"
                  alt={demoAlt}
                  width={tuiDemoSize.width}
                  height={tuiDemoSize.height}
                  unoptimized
                  loading="lazy"
                  fetchPriority="high"
                  className="h-auto w-full dark:hidden"
                />
                <Image
                  src="/tui-demo.svg"
                  alt={demoAlt}
                  width={tuiDemoSize.width}
                  height={tuiDemoSize.height}
                  unoptimized
                  loading="lazy"
                  fetchPriority="high"
                  className="hidden h-auto w-full dark:block"
                />
                <TuiHeroCursors />
              </div>
            </div>
            <TechnicalCaption
              id="figure-01-caption"
              number="1"
              className="bg-marketing-raise px-(--site-gutter) py-5"
              action={
                <Link href="/docs/demo" className="marketing-link-action shrink-0 text-fd-primary">
                  How this demo is made →
                </Link>
              }
            >
              Production app / sessions, agents, panes, and Commands
            </TechnicalCaption>
          </figure>
        </Band>
      </Stretch>

      <Stretch ground="raise">
        {AGENT_SECTIONS.map((section, index) => (
          <AgentSectionBand key={section.id} section={section} motionIndex={index} />
        ))}
      </Stretch>

      <Stretch ground="panel">
        <Band rule={false}>
          <BandBody>
            <SectionHeader
              align="center"
              className="max-w-none"
              eyebrow="One command to install"
              title="Put your agents in tmux."
              description="The installer bundles tmux 3.7c and its own Node.js runtime, and leaves the tmux sessions you already run untouched."
            />
            <div className="mt-8 flex flex-col items-center text-center">
              <InstallCommand command={INSTALL_COMMAND} />
              <p className="type-body mt-4 text-fd-muted-foreground">
                Then run <code className="font-mono text-fd-foreground">{APP_COMMAND}</code>
                {dot}
                <Link
                  href="/docs/getting-started"
                  className="marketing-link-action text-fd-foreground"
                >
                  Read the guide →
                </Link>
              </p>
            </div>
          </BandBody>
        </Band>
      </Stretch>
    </MarketingFrame>
  );
}
