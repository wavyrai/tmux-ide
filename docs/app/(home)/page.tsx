import Link from "next/link";
import type { Metadata } from "next";
import { CopyButton } from "./copy-button";
import TerminalDemo from "@/components/terminal-demo";

export const metadata: Metadata = {
  title: "tmux-ide — Autonomous Multi-Agent Missions",
  description:
    "Turn any project into a mission-driven development environment. One config file, multiple AI agents, fully autonomous orchestration.",
  openGraph: {
    title: "tmux-ide 2.0 — Autonomous Multi-Agent Missions",
    description:
      "Mission-driven orchestration with milestones, validation contracts, skill-based dispatch, and live metrics.",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "tmux-ide 2.0" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "tmux-ide 2.0 — Autonomous Multi-Agent Missions",
    description:
      "Mission-driven orchestration with milestones, validation contracts, and skill-based dispatch.",
    images: ["/og-image.png"],
  },
  alternates: { canonical: "/" },
};

const installCommand = "npm i -g tmux-ide";

const STRIPE_BG =
  "repeating-linear-gradient(-60deg, transparent, transparent 4px, var(--fd-border) 4px, var(--fd-border) 5px)";

function SectionDivider() {
  return (
    <div className="w-full py-1">
      <div
        className="h-4 w-full border-y border-fd-border"
        style={{ backgroundImage: STRIPE_BG }}
      />
    </div>
  );
}

function D({ children }: { children: string }) {
  return <span className="text-fd-primary">{children}</span>;
}

const features = [
  {
    title: "Milestone Gating",
    description:
      "Sequential execution phases, each gating the next. Tasks only dispatch when their milestone is active.",
  },
  {
    title: "Validation Contracts",
    description:
      "Assertion-based verification with independent validation. Failed assertions auto-create remediation tasks.",
  },
  {
    title: "Skill-Based Dispatch",
    description:
      "Match task specialty to agent capabilities. Specialists get specialist work. Tasks wait for the right agent.",
  },
  {
    title: "Knowledge Library",
    description:
      "Shared learnings that persist across tasks. Architecture docs and tag-matched references inject into prompts.",
  },
  {
    title: "Researcher Agent",
    description:
      "Continuous internal auditing triggered by mission events. Writes findings to the library for future agents.",
  },
  {
    title: "Live Metrics",
    description:
      "Session duration, agent utilization, completion rates, retry rates. All computed in real-time.",
  },
  {
    title: "Web Dashboard",
    description:
      "Real-time KPIs, milestone timeline, agent performance table, validation status. Auto-refreshes.",
  },
  {
    title: "Coverage Invariant",
    description:
      "Every assertion in the contract must be claimed by at least one task before dispatch begins.",
  },
  {
    title: "Multi-Agent",
    description:
      "Claude Code, Codex, or any CLI agent. Prefix-matched detection works with platform-specific binaries.",
  },
  {
    title: "Built-in Skills",
    description:
      "5 templates: general-worker, frontend, backend, reviewer, researcher. Scaffold custom skills in seconds.",
  },
  {
    title: "Services Registry",
    description:
      "Centralized commands, ports, healthchecks in ide.yml. Injected into dispatch prompts for agent awareness.",
  },
  {
    title: "File-Based Send",
    description:
      "Long messages auto-route through dispatch files. No paste-mode issues with any agent TUI.",
  },
];

export default function HomePage() {
  return (
    <div className="font-mono">
      {/* HERO */}
      <section className="max-w-screen-xl mx-auto pt-16 pb-12 md:py-28 flex flex-col lg:flex-row gap-12 justify-between items-center px-6">
        <div className="lg:max-w-[560px] space-y-8 w-full">
          <div>
            <span
              aria-hidden="true"
              className="font-pixel text-5xl sm:text-6xl md:text-7xl tracking-tight text-fd-foreground select-none"
            >
              tmux-ide
            </span>
            <Link
              href="/docs/release-2-0-0"
              className="ml-3 inline-flex items-center border border-fd-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em] text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground align-middle"
            >
              2.0
            </Link>
            <h1 className="font-sans text-3xl md:text-4xl lg:text-5xl leading-[1.1] tracking-tight mt-4 text-fd-foreground">
              Autonomous multi-agent missions.
            </h1>
            <p className="text-fd-muted-foreground text-base leading-normal mt-4 md:mt-8">
              Turn any project into a mission-driven development environment. One config file,
              multiple AI agents, fully autonomous orchestration.
            </p>
          </div>

          <div className="max-w-[480px]">
            <CopyButton
              text={installCommand}
              className="group flex items-center gap-3 w-full border border-fd-border p-2 px-4 text-sm transition-colors hover:bg-fd-accent cursor-pointer relative bg-fd-muted/10"
            >
              <span className="text-fd-foreground">$ {installCommand}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="ml-auto text-fd-muted-foreground group-hover:text-fd-foreground transition-colors shrink-0"
              >
                <rect x="9" y="9" width="13" height="13" rx="0" ry="0" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </CopyButton>
          </div>

          <div className="flex items-center gap-4">
            <Link
              href="/docs/getting-started"
              className="bg-fd-primary px-6 py-2.5 text-sm font-mono text-fd-primary-foreground hover:opacity-90 transition-opacity"
            >
              Get started
            </Link>
            <a
              href="https://github.com/wavyrai/tmux-ide"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-fd-border px-6 py-2.5 text-sm font-mono text-fd-foreground hover:bg-fd-accent transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>

        <TerminalDemo />
      </section>

      <div className="space-y-16 max-w-screen-lg mx-auto px-6">
        {/* FEATURES */}
        <div>
          <h2 className="font-sans text-2xl text-fd-foreground">Features</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 mt-4">
            {features.map((f) => (
              <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]" key={f.title}>
                <div className="p-4 space-y-4">
                  <h3 className="text-sm text-fd-foreground">{f.title}</h3>
                  <p className="text-fd-muted-foreground text-sm">{f.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <SectionDivider />

        {/* HOW IT WORKS */}
        <div>
          <h2 className="font-sans text-2xl text-fd-foreground">How it works</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 mt-4">
            {[
              {
                phase: "01",
                title: "Planning",
                description:
                  "The lead agent analyzes your mission, creates milestones, tasks, and a validation contract with testable assertions.",
              },
              {
                phase: "02",
                title: "Execution",
                description:
                  "Tasks dispatch to skill-matched agents. Milestone gating ensures sequential phases. Knowledge accumulates as agents work.",
              },
              {
                phase: "03",
                title: "Validation",
                description:
                  "An independent validator checks each assertion. Failed checks auto-create remediation tasks. The milestone loops until all pass.",
              },
              {
                phase: "04",
                title: "Complete",
                description:
                  "All milestones validated. Mission marked complete. PR auto-created. Metrics and learnings persisted for next time.",
              },
            ].map((item) => (
              <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]" key={item.phase}>
                <div className="p-4 space-y-3">
                  <span className="text-xs text-fd-muted-foreground uppercase tracking-widest">
                    Phase {item.phase}
                  </span>
                  <h3 className="text-sm text-fd-foreground">{item.title}</h3>
                  <p className="text-fd-muted-foreground text-sm">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <SectionDivider />

        {/* ARCHITECTURE */}
        <div className="hidden md:block text-center">
          <h2 className="font-sans text-2xl text-fd-foreground">Architecture</h2>
          <p className="text-fd-muted-foreground text-base leading-normal mt-4 max-w-md mx-auto">
            From mission creation to PR — fully autonomous.
          </p>
          <div className="flex justify-center mt-6">
            <pre className="text-sm leading-5 text-fd-foreground text-left">
              {"  Mission ──► Planning ──► Milestones ──► Tasks\n"}
              {"                                           │\n"}
              {"                            Skill Match ◄──┘\n"}
              {"                                │\n"}
              {"                          Agent Dispatch\n"}
              {"                                │\n"}
              {"                      ┌─────────┴─────────┐\n"}
              {"                      │                   │\n"}
              {"                 "}
              <D>Completion</D>
              {"          "}
              <D>Validation</D>
              {"\n"}
              {"                      │                   │\n"}
              {"                 Knowledge ◄──── Remediation\n"}
              {"                      │\n"}
              {"                "}
              <D>Mission Complete</D>
              {" ──► PR\n"}
            </pre>
          </div>
        </div>

        <SectionDivider />

        {/* SURFACE AREAS — 3-column like midday CLI/MCP/DX */}
        <div className="grid grid-cols-1 md:grid-cols-3">
          <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]">
            <div className="p-4 space-y-4">
              <h3 className="text-sm text-fd-foreground">Orchestrator</h3>
              <ul className="text-fd-muted-foreground space-y-2">
                <li className="text-sm">{"◇"} Mission lifecycle: planning → complete</li>
                <li className="text-sm">{"◇"} Milestone gating with auto-progression</li>
                <li className="text-sm">{"◇"} Skill-matched dispatch</li>
                <li className="text-sm">{"◇"} Stall detection and retry with backoff</li>
                <li className="text-sm">{"◇"} Agent heartbeat telemetry</li>
              </ul>
            </div>
          </div>
          <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]">
            <div className="p-4 space-y-4">
              <h3 className="text-sm text-fd-foreground">Validation</h3>
              <ul className="text-fd-muted-foreground space-y-2">
                <li className="text-sm">{"◇"} Assertion-based contracts</li>
                <li className="text-sm">{"◇"} Independent validator dispatch</li>
                <li className="text-sm">{"◇"} Auto-remediation on failure</li>
                <li className="text-sm">{"◇"} Coverage invariant enforcement</li>
                <li className="text-sm">{"◇"} Blocked assertion tracking</li>
              </ul>
            </div>
          </div>
          <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]">
            <div className="p-4 space-y-4">
              <h3 className="text-sm text-fd-foreground">Developer experience</h3>
              <ul className="text-fd-muted-foreground space-y-2">
                <li className="text-sm">{"◇"} Single command to start</li>
                <li className="text-sm">{"◇"} Web dashboard at localhost:6060</li>
                <li className="text-sm">{"◇"} REST API + SSE events</li>
                <li className="text-sm">{"◇"} TUI widgets in tmux</li>
                <li className="text-sm">{"◇"} Open source</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER CTA */}
      <div className="max-w-screen-lg mx-auto mt-16 mb-24 px-6">
        <div
          className="bg-fd-background border border-fd-border p-8 lg:p-12 text-center relative before:absolute before:inset-0 before:pointer-events-none"
          style={{ "--stripe-bg": STRIPE_BG } as React.CSSProperties}
        >
          <div
            className="absolute inset-0 pointer-events-none opacity-30"
            style={{ backgroundImage: STRIPE_BG }}
          />
          <div className="relative z-10">
            <h2 className="font-sans text-2xl sm:text-3xl text-fd-foreground mb-4">
              Get started
            </h2>
            <p className="font-sans text-base text-fd-muted-foreground mb-6 max-w-lg mx-auto">
              One config. Multiple agents. Fully autonomous.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Link
                href="/docs/getting-started"
                className="bg-fd-primary px-6 py-2.5 text-sm font-mono text-fd-primary-foreground hover:opacity-90 transition-opacity"
              >
                Get started
              </Link>
              <Link
                href="/docs/release-2-0-0"
                className="border border-fd-border px-6 py-2.5 text-sm font-mono text-fd-foreground hover:bg-fd-accent transition-colors"
              >
                What&apos;s new in 2.0
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <footer className="w-full border-t border-fd-border py-8 px-6">
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-fd-muted-foreground">
          <span>
            tmux-ide by{" "}
            <a
              href="https://thijsverreck.com"
              className="hover:text-fd-foreground transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              Thijs Verreck
            </a>
          </span>
          <div className="flex items-center gap-4">
            <Link href="/docs" className="hover:text-fd-foreground transition-colors">
              Docs
            </Link>
            <a
              href="https://github.com/wavyrai/tmux-ide"
              className="hover:text-fd-foreground transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
