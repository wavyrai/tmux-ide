import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

import { AppIcon } from "@/components/app-icon";
import { AsciiLogo } from "./ascii-logo";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = {
  title: "tmux-ide — build a dedicated tmux workspace for your coding agents",
  description:
    "Turn ordinary tmux sessions into a dedicated workspace for coding agents, with memorable names, live agent indicators, direct navigation, durable sessions, and SSH support.",
  alternates: { canonical: "/" },
};

const installCommand = "npm install -g tmux-ide@beta";

const capabilities = [
  [
    "A workspace for your agents",
    "Keep coding agents, shells, logs, and dev servers together in one dedicated, navigable workspace.",
  ],
  [
    "Memorable names",
    "Replace pane IDs and generic shell titles with names such as talented-toucan, then rename them whenever you want.",
  ],
  [
    "Live agent indicators",
    "See which agents are working, idle, need attention, or are done in the sidebar and pane chrome.",
  ],
  [
    "Jump straight to an agent",
    "Select an agent in the sidebar and tmux-ide takes you directly to its exact window and pane.",
  ],
  [
    "Mouse and keyboard",
    "Create, split, resize, rename, focus, and close panes and windows without giving up terminal-native controls.",
  ],
  [
    "Still ordinary tmux",
    "tmux remains the process, PTY, layout, and persistence authority, locally or over SSH.",
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
          Build a dedicated workspace for your coding agents.
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-fd-muted-foreground md:text-lg">
          tmux-ide turns ordinary tmux sessions into an agent-aware workspace. Give agents and panes
          memorable names, see what every agent is doing, and jump directly to the one that needs
          you. Close the app and every session keeps running.
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

      <section className="mt-20">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">
              The real renderer
            </p>
            <h2 className="mt-3 text-3xl tracking-tight text-fd-foreground">
              Your agents, organized and visible at a glance.
            </h2>
          </div>
          <Link href="/docs/demo" className="font-mono text-sm text-fd-primary hover:underline">
            How the demo is made →
          </Link>
        </div>
        <div className="mt-7 overflow-hidden border border-fd-border bg-[#0f0f14] p-1 shadow-2xl shadow-black/10">
          <Image
            src="/tui-demo.svg"
            alt="Animated tmux-ide OpenTUI tour showing Home, an agent-aware terminal workspace, and the Commands palette"
            width={1344}
            height={792}
            unoptimized
            loading="eager"
            className="h-auto w-full"
          />
        </div>
        <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
          Generated from the production OpenTUI component tree with a deterministic in-memory tmux
          fixture. Reduced-motion settings show the terminal workspace as a still frame.
        </p>
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
        <h2 className="text-3xl tracking-tight text-fd-foreground">
          Give your agents a workspace—not a pile of terminals.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-fd-muted-foreground">
          Start with the tmux sessions you already use. tmux-ide adds the names, status, navigation,
          and controls that make a multi-agent setup manageable.
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
