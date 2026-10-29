import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AGENT_SECTIONS,
  AGENTS_PAGE,
  type CommandLine,
} from "@/components/dev-mockups/agents/content";
import { MockupShell } from "@/components/dev-mockups/agents/mockup-shell";
import { InstallCommand } from "@/components/marketing/install-tabs";
import {
  Band,
  BandBody,
  Cell,
  MarketingFrame,
  MarketingGrid,
  Stretch,
} from "@/components/marketing/lattice";
import { SectionHeader } from "@/components/marketing/section-header";
import { TechnicalCaption } from "@/components/marketing/technical-caption";
import { TuiHeroCursors } from "@/components/marketing/tui-cursor";
import tuiDemoSize from "@/components/marketing/tui-demo-size.json";
import { TuiMiniFigure } from "@/components/marketing/tui-mini-figure";
import { APP_COMMAND, INSTALL_COMMAND } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: AGENTS_PAGE.title },
  description: AGENTS_PAGE.description,
  alternates: { canonical: "/dev/tmux-for-coding-agents" },
  robots: { index: false, follow: false },
};

const bodyCopy = "type-marketing-body max-w-[62ch] text-fd-muted-foreground";
const demoAlt =
  "Animated tmux-ide app showing agent status, terminal panes, window controls, and Commands";

/** Plain-text copy with `code` spans. */
function withCode(text: string) {
  return text.split(/(`[^`]+`)/u).map((part, index) =>
    part.startsWith("`") ? (
      <code key={index} className="font-mono text-fd-foreground">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function Commands({ lines }: { lines: readonly CommandLine[] }) {
  return (
    <pre className="type-caption-1 overflow-x-auto border border-marketing-line bg-marketing-panel px-4 py-3 font-mono text-fd-foreground">
      <code>
        {lines.map(({ command, comment }) => (
          <span key={command} className="block whitespace-pre">
            <span aria-hidden className="mr-2 text-fd-muted-foreground">
              $
            </span>
            {command}
            {comment ? <span className="text-fd-muted-foreground">{`  # ${comment}`}</span> : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

export default function TmuxForCodingAgentsMockup() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <MockupShell card="#643">
      <MarketingFrame id="main-content" tabIndex={-1}>
        <Stretch ground="paper">
          <Band>
            <BandBody className="pb-12 pt-12! md:pb-16 md:pt-16!">
              <div className="mx-auto flex max-w-[58rem] flex-col items-center text-center">
                <p className="type-subheadline text-fd-muted-foreground">
                  Claude Code · Codex · Aider · 14 more agent CLIs
                </p>
                <h1 className="type-hero-title mt-4 text-hero-ink">tmux for coding agents</h1>
                <p className="type-hero-lede mt-6 max-w-[58ch] text-hero-body">
                  {AGENTS_PAGE.lede}
                </p>
                <div className="mt-8 flex w-full flex-col items-center">
                  <InstallCommand command={INSTALL_COMMAND} />
                  <p className="type-body mt-4 text-fd-muted-foreground">
                    Then run <code className="font-mono text-fd-foreground">{APP_COMMAND}</code>
                    <span aria-hidden className="mx-3">
                      ·
                    </span>
                    macOS and glibc Linux, no sudo
                    <span aria-hidden className="mx-3">
                      ·
                    </span>
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
            <figure id="figure-01" aria-labelledby="figure-01-caption">
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
                  <Link
                    href="/docs/demo"
                    className="marketing-link-action shrink-0 text-fd-primary"
                  >
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
          {AGENT_SECTIONS.map((section, sectionIndex) => (
            <Band key={section.id}>
              <BandBody>
                <MarketingGrid className="items-start">
                  <Cell className="lg:col-span-10">
                    <div>
                      <div className="type-caption-1 flex items-center gap-4 text-fd-muted-foreground">
                        <span className="font-mono">{section.index}</span>
                        <span>{section.eyebrow}</span>
                      </div>
                      <h2
                        id={section.id}
                        className="type-display-4 mt-6 max-w-[22ch] text-fd-foreground"
                      >
                        {section.title}
                      </h2>
                      {section.body.map((paragraph) => (
                        <p key={paragraph} className={`mt-4 ${bodyCopy}`}>
                          {withCode(paragraph)}
                        </p>
                      ))}
                      <ul className="type-body mt-6 flex flex-wrap gap-x-6 gap-y-2">
                        {section.links.map((link) => (
                          <li key={link.href}>
                            <Link
                              href={link.href}
                              className="marketing-link-action text-fd-primary"
                            >
                              {link.label} →
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Cell>
                  <Cell className="flex flex-col gap-4 lg:col-span-13 lg:col-start-12">
                    <Commands lines={section.commands} />
                    {section.figure ? (
                      <TuiMiniFigure
                        variant={section.figure.variant}
                        figure={section.figure}
                        motionCount={3}
                        motionIndex={sectionIndex}
                      />
                    ) : null}
                  </Cell>
                </MarketingGrid>
              </BandBody>
            </Band>
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
                  <span aria-hidden className="mx-3">
                    ·
                  </span>
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
    </MockupShell>
  );
}
