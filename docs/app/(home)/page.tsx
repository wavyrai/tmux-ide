import Link from "next/link";
import type { Metadata } from "next";
import { CopyButton } from "./copy-button";
import { ConfigPlayground } from "./config-playground";
import { AgentTeamDemo } from "./agent-team-demo";

export const metadata: Metadata = {
  title: "tmux-ide — Prepare Claude agent-team layouts in one terminal",
  description:
    "Prepare Claude Code agent-team-ready tmux layouts. One lead pane, multiple teammate panes, practical prompts, and the right environment setup in one YAML config.",
  openGraph: {
    title: "tmux-ide — Prepare Claude agent-team layouts in one terminal",
    description:
      "Prepare Claude Code agent-team-ready tmux layouts with lead and teammate panes plus the right environment setup.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "tmux-ide — Claude agent-team layouts in tmux",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "tmux-ide — Prepare Claude agent-team layouts in one terminal",
    description:
      "Prepare Claude Code agent-team-ready tmux layouts with lead and teammate panes plus the right environment setup.",
    images: ["/og-image.png"],
  },
  alternates: {
    canonical: "/",
  },
};

const installCommand = "curl -fsSL https://tmux.thijsverreck.com/install.sh | sh";

function InstallButton() {
  return (
    <div className="flex flex-col items-center gap-3">
      <CopyButton
        text={installCommand}
        className="group inline-flex items-center gap-3 rounded-lg border border-fd-border bg-fd-background px-5 py-3 font-mono text-sm transition-colors hover:bg-fd-accent cursor-pointer"
      >
        <span className="text-fd-muted-foreground select-none">$</span>
        <span className="text-fd-foreground">{installCommand}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-fd-muted-foreground group-hover:text-fd-foreground transition-colors shrink-0"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </CopyButton>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-fd-muted-foreground">
        <span>
          or <code className="font-mono text-fd-foreground">npm i -g tmux-ide</code>
        </span>
        <span>
          or try instantly with <code className="font-mono text-fd-foreground">npx tmux-ide</code>
        </span>
      </div>
    </div>
  );
}

function Feature({ title, description }: { title: string; description: string }) {
  return (
    <div className="text-center space-y-2">
      <h3 className="font-medium text-fd-foreground">{title}</h3>
      <p className="text-sm text-fd-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-col items-center flex-1">
      {/* Hero */}
      <section className="flex flex-col items-center gap-8 px-6 pt-24 pb-16 max-w-3xl mx-auto text-center">
        <div className="flex flex-col items-center gap-3">
          <span
            aria-hidden="true"
            className="font-pixel text-6xl sm:text-7xl md:text-8xl tracking-tight text-fd-foreground select-none"
          >
            tmux-ide
          </span>
          <Link
            href="/docs/release-1-2-0"
            className="inline-flex items-center rounded-full border border-fd-border bg-fd-card px-3 py-1 text-[11px] font-mono font-medium uppercase tracking-[0.18em] text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
          >
            New 1.2.0
          </Link>
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-fd-foreground">
          Prepare Claude agent-team layouts
          <br />
          <span className="text-fd-muted-foreground">in one terminal.</span>
        </h1>
        <p className="text-lg text-fd-muted-foreground max-w-xl leading-relaxed">
          Build a lead pane, teammate-ready Claude panes, and your dev tools in one tmux layout.
          tmux-ide enables the right environment; Claude forms the team after you prompt it.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-4">
          <Link
            href="/docs/agent-teams"
            className="rounded-lg bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground hover:bg-fd-primary/90 transition-colors"
          >
            Set Up Agent Teams
          </Link>
          <Link
            href="/docs/getting-started"
            className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium text-fd-foreground hover:bg-fd-accent transition-colors"
          >
            Get Started
          </Link>
          <Link
            href="/docs"
            className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground transition-colors"
          >
            Docs
          </Link>
        </div>
      </section>

      {/* Install */}
      <section className="flex flex-col items-center gap-4 px-6 pb-20">
        <InstallButton />
        <p className="text-xs text-fd-muted-foreground mt-2">
          The install script also registers the{" "}
          <Link
            href="/docs/getting-started#claude-code-skill"
            className="underline hover:text-fd-foreground transition-colors"
          >
            Claude Code skill
          </Link>{" "}
          — so Claude can configure your workspace automatically.
        </p>
      </section>

      {/* Agent Teams Demo */}
      <section className="w-full px-6 pb-24">
        <div className="text-center mb-10">
          <h2 className="text-2xl font-semibold text-fd-foreground">
            Team-ready panes, then Claude takes over
          </h2>
          <p className="text-sm text-fd-muted-foreground mt-2 max-w-lg mx-auto">
            tmux-ide prepares the panes and enables agent-team mode. From there, prompt the lead to
            organize the team and assign work in natural language.
          </p>
        </div>
        <AgentTeamDemo />
        <div className="flex justify-center mt-6">
          <Link
            href="/docs/agent-teams"
            className="text-sm text-fd-muted-foreground hover:text-fd-foreground transition-colors"
          >
            Read the Agent Teams guide →
          </Link>
        </div>
      </section>

      {/* Config Playground */}
      <section className="w-full px-6 pb-20">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-fd-foreground">Config in, layout out</h2>
          <p className="text-sm text-fd-muted-foreground mt-2">
            Edit the YAML and watch the layout update live. Try a preset to get started.
          </p>
        </div>
        <ConfigPlayground />
      </section>

      {/* Features */}
      <section className="w-full max-w-4xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-10">
          <Feature
            title="Lead + teammates"
            description="One Claude coordinates the team. Teammates work independently in their own panes, each with a focused task."
          />
          <Feature
            title="Shared task list"
            description="Agents communicate through shared tasks and messages. The lead assigns, teammates claim and report back."
          />
          <Feature
            title="Self-organizing"
            description="Once the layout is running, the lead can recruit teammates, reassign work, and reshape the workflow through normal Claude prompting."
          />
          <Feature
            title="Declarative YAML"
            description="Define your team layout in ide.yml — roles, tasks, pane sizes. Reproducible across machines and projects."
          />
          <Feature
            title="Any stack"
            description="Auto-detects Next.js, Vite, Python, Go, and more. Dev servers run alongside your agent team."
          />
          <Feature
            title="One command"
            description="tmux-ide handles tmux sessions, pane splitting, and the experimental env flag. You launch the layout, then tell Claude how to organize the team."
          />
          <Feature
            title="Claude Code skill built in"
            description="The install script registers a Claude Code skill automatically. Ask Claude to set up your workspace and it handles detection, layout, and config."
          />
        </div>
      </section>

      {/* Workflow */}
      <section className="w-full max-w-2xl mx-auto px-6 pb-24">
        <div className="rounded-lg border border-fd-border bg-fd-background overflow-hidden">
          <div className="px-4 py-2.5 border-b border-fd-border">
            <span className="text-xs text-fd-muted-foreground font-mono">Quick start</span>
          </div>
          <div className="p-4 font-mono text-sm space-y-1 text-fd-foreground/80">
            <p>
              <span className="text-fd-muted-foreground select-none">$ </span>
              cd ~/Developer/my-project
            </p>
            <p>
              <span className="text-fd-muted-foreground select-none">$ </span>
              tmux-ide init --template agent-team
            </p>
            <p className="text-fd-muted-foreground">→ Created ide.yml with agent team layout.</p>
            <p>
              <span className="text-fd-muted-foreground select-none">$ </span>
              tmux-ide
            </p>
            <p className="text-fd-muted-foreground">
              → Launching IDE session with lead and teammate-ready panes...
            </p>
            <p>
              <span className="text-fd-muted-foreground select-none">$ </span>
              tmux-ide restart
            </p>
            <p className="text-fd-muted-foreground">→ Restarted with updated layout.</p>
          </div>
        </div>
      </section>

      {/* Footer */}
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
              href={`https://github.com/wavyrai/tmux-ide`}
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
