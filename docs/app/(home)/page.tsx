import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { AppIcon } from "@/components/app-icon";
import { AsciiWordmark } from "@/components/ascii-wordmark";
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
import {
  LANDING_AGENT_FEATURES,
  LANDING_ARCHITECTURE,
  LANDING_CAPABILITIES,
  LANDING_FAQ,
} from "@/lib/landing-content";
import { APP_COMMAND, CURRENT_RELEASE_PATH, INSTALL_COMMAND } from "@/lib/site";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = {
  title: "tmux-ide — a dedicated workspace for coding agents",
  description:
    "Give coding agents a dedicated tmux workspace with memorable names, live status, exact pane navigation, terminal-native controls, durable sessions, and SSH support.",
  alternates: { canonical: "/" },
};

const bodyCopy = "marketing-type-body max-w-[62ch] text-fd-muted-foreground";
const agentVisuals = ["names", "status", "navigate"] satisfies TuiFigureVariant[];
const architectureVisuals = ["tmux", "daemon", "opentui"] satisfies TuiFigureVariant[];

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
          <BandBody className="pb-10 pt-10! md:pb-12 md:pt-12!">
            <Link
              href={CURRENT_RELEASE_PATH}
              className="marketing-enter-fast marketing-pill-action mb-8 inline-flex items-center gap-2 rounded-full border border-marketing-line bg-marketing-raise px-3 py-1.5 text-xs text-fd-foreground"
            >
              <span className="marketing-flag font-mono text-fd-primary">New</span>
              <span>OpenTUI workspace in 2.9</span>
              <span aria-hidden className="text-fd-muted-foreground">
                →
              </span>
            </Link>
            <div className="mb-10 w-full max-w-3xl">
              <AsciiWordmark animated className="marketing-enter-step-2" />
            </div>
            <MarketingGrid className="items-end gap-y-8 lg:gap-x-12">
              <Cell className="marketing-enter marketing-enter-step-3 lg:col-span-14">
                <span className="marketing-flag marketing-type-caption font-mono text-fd-primary">
                  Build your team of agents
                </span>
                <h1 className="text-marketing-display mt-5 max-w-[17ch] text-fd-foreground">
                  A dedicated workspace for your coding agents.
                </h1>
              </Cell>

              <Cell className="marketing-enter marketing-enter-step-4 lg:col-span-10">
                <p className="text-marketing-lead mt-7 max-w-[62ch] text-fd-muted-foreground">
                  Build, coordinate, and navigate a team of coding agents from one agent-aware
                  communication plane. See what every agent is doing and jump directly to the one
                  that needs you.
                </p>
                <CopyButton
                  text={INSTALL_COMMAND}
                  className="marketing-copy-action mt-7 flex w-full max-w-lg cursor-pointer items-center gap-3 border border-fd-primary bg-fd-primary px-5 py-3.5 text-left text-sm text-fd-primary-foreground"
                >
                  <span aria-hidden>$</span>
                  <code className="font-mono">{INSTALL_COMMAND}</code>
                  <span className="ml-auto text-xs opacity-65">copy</span>
                </CopyButton>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-fd-muted-foreground">
                  <span>
                    Then run <code className="font-mono text-fd-foreground">{APP_COMMAND}</code>
                  </span>
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
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-fd-muted-foreground">
                        <span aria-hidden>★</span>
                        <span>{formatStars(stars)}</span>
                      </span>
                    ) : null}
                  </a>
                </div>
              </Cell>
            </MarketingGrid>
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
                  alt="Animated production tmux-ide OpenTUI showing agent status, terminal panes, window controls, and the command palette"
                  width={1344}
                  height={792}
                  unoptimized
                  loading="eager"
                  className="h-auto w-full"
                />
              </div>
            </div>
            <TechnicalCaption
              id="figure-01-caption"
              number="01"
              ruled={false}
              className="bg-marketing-raise px-6 py-5 xl:px-10"
              action={
                <Link href="/docs/demo" className="marketing-link-action shrink-0 text-fd-primary">
                  Method notes →
                </Link>
              }
            >
              Production OpenTUI / sessions, agents, panes, and commands
            </TechnicalCaption>
          </figure>
        </Band>
      </Stretch>

      <Stretch ground="raise">
        <Band>
          <BandBody>
            <SectionHeader
              eyebrow="one workspace, every agent accounted for"
              title="Name them. See their state. Go straight to the right pane."
              description="A clear three-step loop replaces terminal hunting with a workspace the whole team can understand."
            />
            <p className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-sm text-fd-muted-foreground">
              <span className="text-fd-foreground">name</span>
              <span aria-hidden>→</span>
              <span className="text-fd-foreground">monitor</span>
              <span aria-hidden>→</span>
              <span className="text-fd-primary">navigate</span>
            </p>
            <Mosaic bleed className="mt-12 lg:grid-cols-3">
              {LANDING_AGENT_FEATURES.map((feature, index) => (
                <Cell
                  key={feature.title}
                  ground="paper"
                  className="flex h-full flex-col p-7 md:p-9"
                >
                  <div className="marketing-flag marketing-type-caption flex items-center justify-between gap-4 font-mono">
                    <span className="text-fd-primary">{feature.index}</span>
                    <span className="text-fd-muted-foreground">{feature.eyebrow}</span>
                  </div>
                  <h3 className="marketing-type-subtitle mt-10 text-fd-foreground">
                    {feature.title}
                  </h3>
                  <p className={`mt-4 ${bodyCopy}`}>{feature.body}</p>
                  <TuiMiniFigure
                    variant={agentVisuals[index]}
                    figure={feature.figure}
                    className="mt-10"
                  />
                </Cell>
              ))}
            </Mosaic>
          </BandBody>
        </Band>
        <Band>
          <BandBody>
            <SectionHeader
              eyebrow="durable by architecture"
              title="Close the interface. Disconnect SSH. Your agents keep running."
              description={
                <>
                  tmux has already absorbed years of terminal, resize, shell, disconnect, and remote
                  session edge cases. Its commands and session vocabulary are also familiar to
                  coding agents. tmux-ide builds on that shared language instead of introducing a
                  private multiplexer protocol.
                </>
              }
            />
            <Mosaic bleed className="mt-12 lg:grid-cols-3">
              {LANDING_ARCHITECTURE.map((layer, index) => (
                <Cell key={layer.owner} ground="paper" className="flex h-full flex-col p-7">
                  <span className="font-mono text-xs text-fd-primary">0{index + 1}</span>
                  <h3 className="mt-8 font-mono text-lg text-fd-foreground">{layer.owner}</h3>
                  <p className="mt-3 min-h-12 font-mono text-xs leading-relaxed text-fd-muted-foreground">
                    {layer.responsibility}
                  </p>
                  <p className="mt-8 border-t border-fd-border pt-4 text-sm text-fd-foreground">
                    {layer.outcome}
                  </p>
                  <TuiMiniFigure
                    variant={architectureVisuals[index]}
                    figure={layer.figure}
                    className="mt-6"
                  />
                </Cell>
              ))}
            </Mosaic>
            <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 font-mono text-sm text-fd-muted-foreground">
              <span className="text-fd-foreground">Local terminal</span>
              <span aria-hidden>→</span>
              <span className="text-fd-foreground">SSH</span>
              <span aria-hidden>→</span>
              <span className="text-fd-primary">same durable tmux workspace</span>
            </div>
            <p className="marketing-type-body mt-6 max-w-[72ch] text-fd-muted-foreground">
              That makes tmux-ide legible to both humans and agents: inspect sessions, target a
              named pane, and communicate through established tmux primitives rather than teaching
              every agent a proprietary control plane.
            </p>
          </BandBody>
        </Band>
      </Stretch>

      <Stretch ground="paper">
        <Band>
          <BandBody>
            <SectionHeader
              eyebrow="everything remains ordinary tmux"
              title="Create, arrange, and operate without breaking flow."
              description="The visual layer maps directly onto familiar tmux operations. Use it when it helps, then drop back to tmux whenever you want."
            />
            <Mosaic bleed className="mt-12 lg:grid-cols-3">
              {LANDING_CAPABILITIES.map((capability, index) => (
                <Cell
                  key={capability.title}
                  ground="raise"
                  className="flex h-full flex-col p-7 md:p-9"
                >
                  <span className="marketing-type-micro font-mono text-fd-primary">
                    {capability.index}
                  </span>
                  <h3 className="marketing-type-subtitle mt-8 text-fd-foreground">
                    {capability.title}
                  </h3>
                  <p className={`mt-4 ${bodyCopy}`}>{capability.body}</p>
                  <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-fd-muted-foreground">
                    {capability.items.map((item) => (
                      <li
                        key={item}
                        className="before:mr-2 before:text-fd-primary before:content-['·']"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                  <TuiMiniFigure
                    variant={capability.visual}
                    figure={capability.figure}
                    motionCount={3}
                    motionIndex={index}
                    className="mt-8"
                  />
                </Cell>
              ))}
            </Mosaic>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fd-muted-foreground">
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
            <SectionHeader eyebrow="questions, answered" title="The important details." />
            <div id="faq" className="mt-12 border-t border-fd-border">
              {LANDING_FAQ.map(({ question, answer }) => (
                <details key={question} className="group border-b border-fd-border py-6">
                  <summary className="flex cursor-pointer list-none items-center gap-6 text-base font-normal text-fd-foreground marker:content-none">
                    <span>{question}</span>
                    <span
                      aria-hidden
                      className="ml-auto font-mono text-fd-primary transition-transform duration-200 ease-smooth group-open:rotate-45 motion-reduce:transition-none"
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
                      ready when you are
                    </span>
                  }
                  title="Build your team of agents."
                  description="Install tmux-ide, open the app, and turn the tmux sessions you already use into one clear agent workspace."
                />
                <div className="mt-8 text-center">
                  <CopyButton
                    text={INSTALL_COMMAND}
                    className="marketing-copy-action flex w-full cursor-pointer items-center gap-3 border border-fd-primary bg-fd-primary px-5 py-3.5 text-left text-sm text-fd-primary-foreground"
                  >
                    <span aria-hidden>$</span>
                    <code className="font-mono">{INSTALL_COMMAND}</code>
                    <span className="ml-auto text-xs opacity-65">copy</span>
                  </CopyButton>
                  <p className="mt-4 text-sm text-fd-muted-foreground">
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
