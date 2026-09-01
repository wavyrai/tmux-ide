import Link from "next/link";
import type { Metadata } from "next";

import { AppIcon } from "@/components/app-icon";
import { AsciiLogo } from "./ascii-logo";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = {
  title: "tmux-ide — a visual tmux client built for coding agents",
  description:
    "A mouse-friendly OpenTUI for ordinary tmux sessions, with agent status, pane and window controls, durable sessions, and SSH support.",
  alternates: { canonical: "/" },
};

const installCommand = "npm install -g tmux-ide@beta";

const capabilities = [
  [
    "Ordinary tmux",
    "Open sessions you already own. tmux remains the process, PTY, layout, and persistence authority.",
  ],
  [
    "Agent-aware chrome",
    "See agent state in the sidebar, window tabs, and pane headers, then jump directly to the right pane.",
  ],
  [
    "Mouse and keyboard",
    "Create, split, resize, rename, focus, and close panes and windows without giving up terminal-native controls.",
  ],
  [
    "SSH by construction",
    "The same tmux sessions remain available from any normal tmux client, locally or over SSH.",
  ],
] as const;

const architecture = [
  ["tmux", "processes · PTYs · sessions · windows · panes"],
  ["daemon", "discovery · lifecycle · agent state · pane streams"],
  ["OpenTUI", "Home · Terminals · chrome · input"],
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-24 pt-20 md:pt-28">
      <section className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <AppIcon size={88} priority />
        <div className="mt-8 w-full max-w-2xl">
          <AsciiLogo />
        </div>
        <p className="mt-7 font-mono text-xs uppercase tracking-[0.2em] text-fd-primary">
          OpenTUI beta · tmux under the hood
        </p>
        <h1 className="mt-4 text-balance text-4xl tracking-tight text-fd-foreground md:text-6xl">
          A visual tmux client designed for working with agents.
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-fd-muted-foreground md:text-lg">
          tmux-ide gives ordinary tmux sessions a polished application shell: clickable panes and
          windows, agent indicators, memorable names, and controls that work locally or over SSH.
          Close it and your tmux sessions keep running.
        </p>

        <CopyButton
          text={installCommand}
          className="mt-9 flex w-full max-w-lg cursor-pointer items-center border border-fd-border bg-fd-card px-4 py-3 text-left font-mono text-sm text-fd-foreground transition-colors hover:bg-fd-accent"
        >
          <span>$ {installCommand}</span>
          <span className="ml-auto text-fd-muted-foreground">copy</span>
        </CopyButton>
        <code className="mt-3 block font-mono text-sm text-fd-muted-foreground">tmux-ide app</code>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/docs/getting-started"
            className="bg-fd-primary px-5 py-2.5 font-mono text-sm text-fd-primary-foreground"
          >
            Get started
          </Link>
          <Link
            href="/docs/release-2-9-0-beta-1"
            className="border border-fd-border px-5 py-2.5 font-mono text-sm text-fd-foreground hover:bg-fd-accent"
          >
            What ships in 2.9
          </Link>
          <a
            href="https://github.com/wavyrai/tmux-ide"
            className="border border-fd-border px-5 py-2.5 font-mono text-sm text-fd-foreground hover:bg-fd-accent"
          >
            GitHub
          </a>
        </div>
      </section>

      <section className="mt-24 border-y border-fd-border py-10">
        <div className="grid gap-px bg-fd-border md:grid-cols-2">
          {capabilities.map(([title, body]) => (
            <article key={title} className="bg-fd-background p-7">
              <h2 className="font-mono text-sm text-fd-foreground">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-20">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">
          One authority per job
        </p>
        <h2 className="mt-3 text-3xl tracking-tight text-fd-foreground">
          Rock-solid because it does not replace tmux.
        </h2>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
          tmux has spent years absorbing terminal, shell, disconnect, resize, and SSH edge cases.
          tmux-ide stays a client of that durable foundation instead of becoming a second
          multiplexer.
        </p>
        <div className="mt-8 grid gap-3 md:grid-cols-3">
          {architecture.map(([owner, responsibility], index) => (
            <div key={owner} className="border border-fd-border bg-fd-card p-5">
              <span className="font-mono text-xs text-fd-primary">0{index + 1}</span>
              <h3 className="mt-3 font-mono text-base text-fd-foreground">{owner}</h3>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{responsibility}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20 border border-fd-border bg-fd-card p-8 text-center md:p-12">
        <h2 className="text-3xl tracking-tight text-fd-foreground">Keep tmux. Add the app.</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-fd-muted-foreground">
          The beta is deliberately focused on Home and Terminals. The future web client will use the
          same daemon boundary; it is not part of this release.
        </p>
        <Link
          href="/docs/getting-started"
          className="mt-6 inline-block bg-fd-primary px-5 py-2.5 font-mono text-sm text-fd-primary-foreground"
        >
          Install the beta
        </Link>
      </section>
    </main>
  );
}
