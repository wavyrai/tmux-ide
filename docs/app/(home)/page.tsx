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

function SectionDivider() {
  return (
    <div className="w-full py-1">
      <div
        className="h-4 w-full border-y border-fd-border"
        style={{
          backgroundImage:
            "repeating-linear-gradient(-60deg, hsla(225, 50%, 35%, 0.4), hsla(225, 50%, 35%, 0.4) 1px, transparent 1px, transparent 6px)",
        }}
      />
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="border border-fd-border p-6 -mt-px -ml-px">
      <h3 className="font-mono text-sm font-medium text-fd-foreground mb-2">{title}</h3>
      <p className="text-sm text-fd-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

const DOT = "hsl(225, 60%, 55%)";
function D({ children }: { children: string }) {
  return <span style={{ color: DOT }}>{children}</span>;
}

export default function HomePage() {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            :root, .dark {
              --background: 225 70% 8% !important;
              --fd-background: hsl(225, 70%, 8%) !important;
              --foreground: 0 0% 95% !important;
              --fd-foreground: hsl(0, 0%, 95%) !important;
              --muted-foreground: 225 30% 65% !important;
              --fd-muted-foreground: hsl(225, 30%, 65%) !important;
              --border: 225 40% 20% !important;
              --fd-border: hsl(225, 40%, 20%) !important;
              --primary: 225 60% 55% !important;
              --fd-primary: hsl(225, 60%, 55%) !important;
              --primary-foreground: 0 0% 100% !important;
              --fd-primary-foreground: hsl(0, 0%, 100%) !important;
              --card: 225 50% 12% !important;
              --fd-card: hsl(225, 50%, 12%) !important;
              --accent: 225 40% 15% !important;
              --fd-accent: hsl(225, 40%, 15%) !important;
            }
          `,
        }}
      />

      <div className="flex flex-col items-center flex-1">
        {/* HERO */}
        <section className="flex flex-col items-center gap-8 px-6 pt-28 pb-16 max-w-3xl mx-auto text-center">
          <div className="flex flex-col items-center gap-3">
            <span
              aria-hidden="true"
              className="font-pixel text-6xl sm:text-7xl md:text-8xl tracking-tight text-fd-foreground select-none"
            >
              tmux-ide
            </span>
            <Link
              href="/docs/release-2-0-0"
              className="inline-flex items-center rounded-full border border-fd-border bg-fd-card px-3 py-1 text-[11px] font-mono font-medium uppercase tracking-[0.18em] text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
            >
              New 2.0
            </Link>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-fd-foreground">
            Autonomous Multi-Agent
            <br />
            <span className="text-fd-muted-foreground">Missions</span>
          </h1>
          <p className="text-lg text-fd-muted-foreground max-w-xl leading-relaxed">
            Turn any project into a mission-driven development environment. One config file,
            multiple AI agents, fully autonomous orchestration.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-4">
            <Link
              href="/docs/getting-started"
              className="rounded-lg bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground hover:opacity-90 transition-opacity"
            >
              Get Started
            </Link>
            <a
              href="https://github.com/wavyrai/tmux-ide"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium text-fd-foreground hover:bg-fd-accent transition-colors"
            >
              View on GitHub
            </a>
          </div>
        </section>

        {/* INSTALL */}
        <section className="w-full max-w-lg mx-auto px-6 pb-12">
          <CopyButton
            text={installCommand}
            className="group flex items-center gap-3 w-full border border-fd-border p-3 px-5 font-mono text-sm transition-colors hover:bg-fd-accent cursor-pointer"
          >
            <span className="text-fd-muted-foreground select-none">$</span>
            <span className="text-fd-foreground">{installCommand}</span>
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
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </CopyButton>
        </section>

        <SectionDivider />

        {/* INTERACTIVE TERMINAL DEMO */}
        <section className="w-full flex flex-col items-center px-6 py-16">
          <TerminalDemo />
        </section>

        <SectionDivider />

        {/* FEATURE GRID */}
        <section className="w-full max-w-5xl mx-auto px-6 py-16">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-semibold text-fd-foreground">
              Everything you need for autonomous missions
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              title="Milestone Gating"
              description="Sequential execution phases, each gating the next. Tasks only dispatch when their milestone is active."
            />
            <FeatureCard
              title="Validation Contracts"
              description="Assertion-based verification with independent validation. Failed assertions auto-create remediation tasks."
            />
            <FeatureCard
              title="Skill-Based Dispatch"
              description="Match task specialty to agent capabilities. Specialists get specialist work. Tasks wait for the right agent."
            />
            <FeatureCard
              title="Knowledge Library"
              description="Shared learnings that persist across tasks. Architecture docs and tag-matched references inject into prompts."
            />
            <FeatureCard
              title="Researcher Agent"
              description="Continuous internal auditing triggered by mission events. Writes findings to the library for future agents."
            />
            <FeatureCard
              title="Live Metrics"
              description="Session duration, agent utilization, completion rates, retry rates. All computed in real-time."
            />
            <FeatureCard
              title="Web Dashboard"
              description="Real-time KPIs, milestone timeline, agent performance table, validation status. Auto-refreshes."
            />
            <FeatureCard
              title="Coverage Invariant"
              description="Every assertion in the contract must be claimed by at least one task before dispatch begins."
            />
            <FeatureCard
              title="Multi-Agent"
              description="Claude Code, Codex, or any CLI agent. Prefix-matched detection works with platform-specific binaries."
            />
            <FeatureCard
              title="Built-in Skills"
              description="5 templates: general-worker, frontend, backend, reviewer, researcher. Scaffold custom skills in seconds."
            />
            <FeatureCard
              title="Services Registry"
              description="Centralized commands, ports, healthchecks in ide.yml. Injected into dispatch prompts for agent awareness."
            />
            <FeatureCard
              title="File-Based Send"
              description="Long messages auto-route through dispatch files. No paste-mode issues with any agent TUI."
            />
          </div>
        </section>

        <SectionDivider />

        {/* ARCHITECTURE DIAGRAM */}
        <section className="w-full max-w-4xl mx-auto px-6 py-16">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-semibold text-fd-foreground">Mission Architecture</h2>
            <p className="text-sm text-fd-muted-foreground mt-2">
              From mission creation to PR — fully autonomous
            </p>
          </div>
          <div className="border border-fd-border p-6 overflow-x-auto">
            <pre className="font-mono text-xs sm:text-sm leading-relaxed text-fd-foreground whitespace-pre">
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
        </section>

        <SectionDivider />

        {/* HOW IT WORKS — 4 lifecycle phases */}
        <section className="w-full max-w-4xl mx-auto px-6 py-16">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-semibold text-fd-foreground">How It Works</h2>
            <p className="text-sm text-fd-muted-foreground mt-2">
              Four phases, fully autonomous
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-fd-border">
            {[
              {
                phase: "1",
                title: "Planning",
                description:
                  "The lead agent analyzes your mission, creates milestones, tasks, and a validation contract with testable assertions.",
              },
              {
                phase: "2",
                title: "Execution",
                description:
                  "Tasks dispatch to skill-matched agents. Milestone gating ensures sequential phases. Knowledge accumulates as agents work.",
              },
              {
                phase: "3",
                title: "Validation",
                description:
                  "An independent validator checks each assertion. Failed checks auto-create remediation tasks. The milestone loops until all pass.",
              },
              {
                phase: "4",
                title: "Complete",
                description:
                  "All milestones validated. Mission marked complete. PR auto-created. Metrics and learnings persisted for next time.",
              },
            ].map((item) => (
              <div key={item.phase} className="bg-fd-card p-6">
                <div className="font-mono text-xs text-fd-muted-foreground mb-2">
                  Phase {item.phase}
                </div>
                <h3 className="font-mono text-sm font-medium text-fd-foreground mb-2">
                  {item.title}
                </h3>
                <p className="text-sm text-fd-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <SectionDivider />

        {/* FOOTER CTA */}
        <section className="w-full max-w-2xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold text-fd-foreground mb-4">Ready to build?</h2>
          <div className="max-w-md mx-auto mb-6">
            <CopyButton
              text={installCommand}
              className="group flex items-center gap-3 w-full border border-fd-border p-3 px-5 font-mono text-sm transition-colors hover:bg-fd-accent cursor-pointer"
            >
              <span className="text-fd-muted-foreground select-none">$</span>
              <span className="text-fd-foreground">{installCommand}</span>
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
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </CopyButton>
          </div>
          <div className="flex justify-center gap-4">
            <Link
              href="/docs/getting-started"
              className="text-sm text-fd-muted-foreground hover:text-fd-foreground transition-colors"
            >
              Read the docs {"\u2192"}
            </Link>
            <Link
              href="/docs/release-2-0-0"
              className="text-sm text-fd-muted-foreground hover:text-fd-foreground transition-colors"
            >
              What&apos;s new in 2.0 {"\u2192"}
            </Link>
          </div>
        </section>

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
    </>
  );
}
