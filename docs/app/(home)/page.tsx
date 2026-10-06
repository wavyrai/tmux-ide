import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { AppIcon } from "@/components/app-icon";
import { CopyAgentPrompt } from "@/components/copy-agent-prompt";
import { LandingFaqJsonLd } from "@/components/landing-faq-json-ld";
import {
  Band,
  BandBody,
  Cell,
  MarketingFrame,
  MarketingGrid,
  Mosaic,
  Stretch,
} from "@/components/marketing/lattice";
import { SectionHeader } from "@/components/marketing/section-header";
import { TechnicalCaption } from "@/components/marketing/technical-caption";
import { TuiMiniFigure, type TuiFigureVariant } from "@/components/marketing/tui-mini-figure";
import { AgentTeamsFigure, ArchitectureFigure } from "@/components/figures/figures";
import tuiDemoSize from "@/components/marketing/tui-demo-size.json";
import {
  LANDING_AGENT_FEATURES,
  LANDING_CAPABILITIES,
  LANDING_FAQ,
  LANDING_HERO,
  INSTALL_METHODS,
} from "@/lib/landing-content";
import { InstallCommand, InstallTabs } from "@/components/marketing/install-tabs";
import {
  APP_COMMAND,
  CURRENT_RELEASE_PATH,
  INSTALL_COMMAND,
  SITE_DESCRIPTION,
  SITE_TITLE,
} from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

const bodyCopy = "type-marketing-body max-w-[62ch] text-fd-muted-foreground";
const agentVisuals = ["names", "status", "navigate"] satisfies TuiFigureVariant[];

async function fetchStarCount(): Promise<number | null> {
  try {
    const response = await fetch("https://api.github.com/repos/wavyrai/tmux-ide", {
      next: { revalidate: 3600 },
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

/** Keeps hyphenated words such as "open-source" from breaking at the hyphen. */
function keepHyphenatedWords(text: string) {
  return text.split(/(\S+-\S+)/u).map((part, index) =>
    index % 2 === 1 ? (
      <span key={part} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function formatStars(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

export default async function HomePage() {
  const stars = await fetchStarCount();

  return (
    <MarketingFrame id="main-content" tabIndex={-1}>
      <Stretch ground="paper">
        <Band>
          <BandBody className="pb-16 pt-12! md:pb-20 md:pt-16!">
            {/* One centred text column over the full-width demo below. */}
            <div className="mx-auto flex max-w-[58rem] flex-col items-center text-center">
              <Link
                href={CURRENT_RELEASE_PATH}
                className="marketing-enter-fast marketing-pill-action mb-8 inline-flex items-center gap-2 rounded-full border border-marketing-line bg-marketing-raise type-caption-1 px-3 py-1.5 text-fd-foreground"
              >
                <span className="text-fd-muted-foreground">New</span>
                <span>The tmux-ide app in 2.9</span>
                <span aria-hidden className="text-fd-muted-foreground">
                  →
                </span>
              </Link>
              <h1 className="type-hero-title marketing-enter marketing-enter-step-2 text-hero-ink">
                {keepHyphenatedWords(LANDING_HERO.title)}
              </h1>
              <p className="type-hero-lede marketing-enter marketing-enter-step-3 mt-6 max-w-[58ch] text-hero-body">
                {LANDING_HERO.ledeLead} {LANDING_HERO.lede}
              </p>
              {/* One CTA block on the install box's width: the box (tabs, command,
                  follow-up), its requirements line, then the agent prompt and links. */}
              <div className="hero-cta marketing-enter marketing-enter-step-4 mt-8">
                <InstallTabs
                  name="install-method-hero"
                  methods={INSTALL_METHODS}
                  then={APP_COMMAND}
                />
                <div className="hero-cta-row">
                  <CopyAgentPrompt size="hero" showPrompt={false} />
                  <div className="type-body flex items-center gap-x-5 text-fd-muted-foreground">
                    <Link
                      href="/docs/getting-started"
                      className="marketing-link-action text-fd-foreground"
                    >
                      Docs →
                    </Link>
                    <a
                      href="https://github.com/wavyrai/tmux-ide"
                      target="_blank"
                      rel="noreferrer"
                      aria-label={
                        stars === null
                          ? "tmux-ide on GitHub (opens in a new tab)"
                          : `tmux-ide on GitHub, ${stars} stars (opens in a new tab)`
                      }
                      className="marketing-link-action inline-flex items-center gap-1.5 text-fd-foreground"
                    >
                      <span>GitHub</span>
                      {stars !== null ? (
                        <span className="type-caption-1 inline-flex items-center gap-1 font-mono text-fd-muted-foreground">
                          <span aria-hidden>★</span>
                          <span>{formatStars(stars)}</span>
                        </span>
                      ) : null}
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </BandBody>
          <figure
            id="figure-01"
            aria-labelledby="figure-01-caption"
            className="marketing-enter marketing-enter-step-5"
          >
            <div className="border-y border-marketing-line bg-terminal-stage p-2 md:p-4">
              <div className="border border-terminal-line bg-terminal-stage">
                <Image
                  src="/tui-demo.svg"
                  alt="Animated tmux-ide app showing agent status, terminal panes, window controls, and Commands"
                  width={tuiDemoSize.width}
                  height={tuiDemoSize.height}
                  unoptimized
                  loading="eager"
                  fetchPriority="high"
                  className="h-auto w-full"
                />
              </div>
            </div>
            <TechnicalCaption
              id="figure-01-caption"
              number="1"
              ruled={false}
              className="bg-marketing-raise px-(--site-gutter) py-5"
              action={
                <Link href="/docs/demo" className="marketing-link-action shrink-0 text-fd-primary">
                  Method notes →
                </Link>
              }
            >
              Production app / sessions, agents, panes, and Commands
            </TechnicalCaption>
          </figure>
        </Band>
      </Stretch>

      <Stretch ground="raise">
        <Band>
          <BandBody>
            <SectionHeader
              eyebrow="One workspace, every agent accounted for"
              title="Named agents with live status."
              titleMuted="Go straight to the right pane."
              description="Name each agent, watch its state, and open its exact pane."
            />
            <p className="type-body mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-fd-muted-foreground">
              <span className="text-fd-foreground">Name</span>
              <span aria-hidden>→</span>
              <span className="text-fd-foreground">Monitor</span>
              <span aria-hidden>→</span>
              <span className="text-fd-foreground">Navigate</span>
            </p>
            <Mosaic bleed className="mt-12 lg:grid-cols-3">
              {LANDING_AGENT_FEATURES.map((feature, index) => (
                <Cell
                  key={feature.title}
                  ground="paper"
                  className="flex h-full flex-col p-7 md:p-9"
                >
                  <div className="type-caption-1 flex items-center justify-between gap-4 text-fd-muted-foreground">
                    <span className="font-mono">{feature.index}</span>
                    <span>{feature.eyebrow}</span>
                  </div>
                  <h3 className="type-card-title mt-10 text-fd-foreground">{feature.title}</h3>
                  <p className={`mt-4 ${bodyCopy}`}>{feature.body}</p>
                  {"link" in feature ? (
                    <Link
                      href={feature.link.href}
                      className="type-body marketing-link-action mt-4 self-start text-fd-primary"
                    >
                      {feature.link.label} →
                    </Link>
                  ) : null}
                  <TuiMiniFigure
                    variant={agentVisuals[index]}
                    figure={feature.figure}
                    motionCount={6}
                    motionIndex={index}
                    className="mt-10"
                  />
                </Cell>
              ))}
            </Mosaic>
          </BandBody>
        </Band>
        <Band>
          <BandBody>
            <AgentTeamsFigure />
          </BandBody>
        </Band>
        <Band>
          <BandBody>
            <ArchitectureFigure />
          </BandBody>
        </Band>
      </Stretch>

      <Stretch ground="paper">
        <Band>
          <BandBody>
            <SectionHeader
              eyebrow="Everything remains ordinary tmux"
              title="Windows, splits and resizing are real tmux operations."
              description="The visual layer maps directly onto familiar tmux operations. Use it when it helps, then drop back to tmux whenever you want."
            />
            <Mosaic bleed className="mt-12 lg:grid-cols-3">
              {LANDING_CAPABILITIES.map((capability, index) => (
                <Cell
                  key={capability.title}
                  ground="raise"
                  className="flex h-full flex-col p-7 md:p-9"
                >
                  <span className="type-caption-1 font-mono text-fd-muted-foreground">
                    {capability.index}
                  </span>
                  <h3 className="type-card-title mt-8 text-fd-foreground">{capability.title}</h3>
                  <p className={`mt-4 ${bodyCopy}`}>{capability.body}</p>
                  <ul className="type-caption-1 mt-6 flex flex-wrap gap-x-5 gap-y-2 text-fd-muted-foreground">
                    {capability.items.map((item) => (
                      <li
                        key={item}
                        className="before:mr-2 before:text-fd-foreground before:content-['·']"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                  <TuiMiniFigure
                    variant={capability.visual}
                    figure={capability.figure}
                    motionCount={6}
                    motionIndex={index + 3}
                    className="mt-8"
                  />
                </Cell>
              ))}
            </Mosaic>
            <div className="type-body mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-fd-muted-foreground">
              <span>Every action remains inspectable from an ordinary tmux client.</span>
              <Link href="/docs/commands" className="marketing-link-action text-fd-primary">
                Explore all commands →
              </Link>
            </div>
          </BandBody>
        </Band>
        <Band>
          <BandBody>
            <LandingFaqJsonLd />
            <SectionHeader eyebrow="Questions, answered" title="tmux-ide FAQ" />
            <div id="faq" className="mt-12 border-t border-fd-border">
              {LANDING_FAQ.map(({ question, answer }) => (
                <details key={question} className="group border-b border-fd-border py-6">
                  <summary className="type-headline flex cursor-pointer list-none items-center gap-6 text-fd-foreground marker:content-none">
                    <span>{question}</span>
                    <span
                      aria-hidden
                      className="ml-auto text-fd-muted-foreground transition-transform duration-200 ease-smooth group-open:rotate-45 motion-reduce:transition-none"
                    >
                      +
                    </span>
                  </summary>
                  <p className={`marketing-faq-answer pt-4 ${bodyCopy}`}>{answer}</p>
                </details>
              ))}
            </div>
          </BandBody>
        </Band>
      </Stretch>

      <Stretch ground="panel">
        {/* The footer owns the closing seam with its top rule. */}
        <Band rule={false}>
          <BandBody>
            <MarketingGrid>
              <Cell className="lg:col-span-12 lg:col-start-7">
                <SectionHeader
                  align="center"
                  className="max-w-none"
                  eyebrow={
                    <span className="inline-flex items-center justify-center gap-3 text-fd-muted-foreground">
                      <AppIcon size={28} />
                      Ready when you are
                    </span>
                  }
                  title="Build your team of agents."
                  description="Install tmux-ide, open the app, and see every agent in the tmux sessions you already use."
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
              </Cell>
            </MarketingGrid>
          </BandBody>
        </Band>
      </Stretch>
    </MarketingFrame>
  );
}
