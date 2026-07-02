import Link from "next/link";
import type { Metadata } from "next";
import { CopyButton } from "./copy-button";
import { AsciiLogo } from "./ascii-logo";
import TerminalDemo from "@/components/terminal-demo";

export const metadata: Metadata = {
  title: "tmux-ide — teach the terminal you already use to understand agents",
  description:
    "tmux-ide adds a native chrome to any tmux session: ground-truth agent status, notifications, and crash-proof restore. One command on the terminal you already run — zero lock-in.",
  openGraph: {
    title: "tmux-ide — the terminal that understands your agents",
    description:
      "Adopt in place, know your fleet at a glance, survive anything. A terminal-native agent cockpit built around tmux.",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "tmux-ide" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "tmux-ide — the terminal that understands your agents",
    description:
      "Ground-truth agent status, notifications, and crash-proof restore — layered onto the tmux you already use.",
    images: ["/og-image.png"],
  },
  alternates: { canonical: "/" },
};

const installCommand = "npm i -g tmux-ide";
const adoptCommand = "tmux-ide adopt <session>";

/**
 * Server-side fetch of the GitHub star count. Cached for an hour via
 * Next's revalidate so we don't burn the API rate limit on every render.
 * Falls back to `null` on failure (rate-limited, network down) — the
 * button degrades to plain "GitHub" without a counter.
 */
async function fetchStarCount(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/wavyrai/tmux-ide", {
      next: { revalidate: 3600 },
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

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

/** The three-beat story — the spine of the pitch. */
const beats = [
  {
    kicker: "Adopt in place",
    title: "One command on the tmux you already run",
    body: "tmux-ide adopt <session> drops a native chrome row onto any existing session — fleet tabs, live agent glyphs, home / switch / keys triggers. It's just tmux options: unadopt reverts it, and if tmux-ide ever dies your sessions are untouched plain tmux. No new terminal to learn, no lock-in.",
  },
  {
    kicker: "Know your fleet",
    title: "Ground-truth agent status, at a glance",
    body: "Install the Claude Code integration and working / blocked / done come straight from the agent's own lifecycle — not a guess. Border chips show claude · working per pane; a toast fires on every attached client the moment an agent goes blocked or done. One glance tells you who needs you.",
  },
  {
    kicker: "Survive anything",
    title: "Rebuild the whole fleet after a crash",
    body: "Continuous snapshots mean a tmux server death isn't a lost afternoon. tmux-ide restore rebuilds every session, window, layout, cwd, and title — and --resume-agents revives your Claude conversations from their recorded session ids. Nothing was lost.",
  },
];

const surfaces = [
  {
    key: "prefix h · ⌥h",
    title: "Home cockpit",
    body: "Bare tmux-ide is the home screen — a fleet tree, detail pane, live preview, and rollup header. prefix h opens it as a popup over any session.",
  },
  {
    key: "prefix b · ⌥b",
    title: "Sidebar",
    body: "A nav column you toggle in any session. The fleet, a keystroke away, without leaving your work.",
  },
  {
    key: "prefix e g v",
    title: "Floating panels",
    body: "File explorer, git changes, and the config editor as popups over whatever you're doing. esc to close.",
  },
  {
    key: "prefix u · right-click",
    title: "Actions menu",
    body: "Right-click any pane or the status bar for a native tmux menu at the pointer — the same actions, wherever you are.",
  },
  {
    key: "prefix k · ⌥k",
    title: "Cheat sheet",
    body: "Every key on one iPadOS-style sheet. One interaction grammar everywhere: j/k move, enter opens, / filters, esc backs out, ? asks.",
  },
  {
    key: "prefix + letter, always",
    title: "Reliable keys",
    body: "Prefix twins work under every keyboard protocol; the ⌥ fast-path is a one-key shortcut when your terminal allows it. One theme file colors chrome AND widgets.",
  },
];

const features = [
  {
    title: "The dock",
    description:
      "A native tmux chrome row on any session: clickable fleet tabs with blocked / working / done / idle glyphs, plus home, switch, and keys triggers.",
  },
  {
    title: "Two-layer detection",
    description:
      "Authoritative status from Claude Code hooks; process-tree + evidence-tuned screen manifests as the fallback. User-overridable, debuggable with agent explain.",
  },
  {
    title: "Self-report contract",
    description:
      "Any agent can join the authority layer by writing one pane option: tmux set-option -p @agent_state working:$(date +%s). No integration required.",
  },
  {
    title: "The who-needs-me loop",
    description:
      "Toasts on any client when an agent goes blocked or done anywhere, optional macOS notifications, and per-pane border chips.",
  },
  {
    title: "Event stream",
    description:
      "tmux-ide events --follow is a JSONL stream of every agent-status transition — pipe it anywhere.",
  },
  {
    title: "Coordination primitives",
    description:
      "wait agent-status and wait output --match block until a session hits a status or a pane matches a regex. Scriptable synchronization.",
  },
  {
    title: "Crash-proof restore",
    description:
      "Continuous snapshots; tmux-ide restore rebuilds sessions, windows, layouts, cwds, and titles after a tmux server death.",
  },
  {
    title: "Conversation revival",
    description:
      "restore --resume-agents brings Claude conversations back via their recorded session ids (claude --resume).",
  },
  {
    title: "Worktree flow",
    description:
      "tmux-ide worktree create <branch> = a git worktree plus an adopted session inside it. Parallel agents on parallel branches.",
  },
  {
    title: "Works over SSH",
    description:
      "The chrome lives server-side, so it renders from any client — including SSH from a laptop or a phone.",
  },
  {
    title: "ide.yml layouts",
    description:
      "Optional: describe rows, panes, commands, and a sidebar in one file. tmux-ide init scaffolds it from your detected stack.",
  },
  {
    title: "Programmatic CLI",
    description:
      "--json on every command. status, inspect, events, and agent explain all speak structured output for scripting.",
  },
];

export default async function HomePage() {
  const stars = await fetchStarCount();
  return (
    <div className="font-mono">
      {/* HERO ROW 1 — full-width ASCII logo + positioning line */}
      <section className="relative max-w-screen-xl mx-auto pt-16 md:pt-28 px-6 text-center">
        <AsciiLogo />
        <div className="mt-4 flex items-center justify-center gap-3">
          <h1 className="font-sans text-3xl md:text-4xl lg:text-5xl leading-[1.1] tracking-tight text-fd-foreground">
            The terminal that understands your agents.
          </h1>
          <Link
            href="/docs/release-2-6-0"
            className="inline-flex items-center border border-fd-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em] text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground shrink-0"
          >
            2.6
          </Link>
        </div>
      </section>

      {/* HERO ROW 2 — two columns: content + terminal */}
      <section className="max-w-screen-xl mx-auto pb-12 md:pb-28 pt-8 md:pt-12 flex flex-col lg:flex-row gap-12 justify-between items-center px-6">
        <div className="lg:max-w-[480px] space-y-8 w-full">
          <p className="text-fd-muted-foreground text-base leading-normal">
            Other tools rebuild the terminal to understand agents. tmux-ide teaches the terminal you
            already use to understand them. One command adds a native chrome to any tmux session —
            ground-truth agent status, notifications, and crash-proof restore. Zero lock-in.
          </p>

          <div className="max-w-[480px] space-y-2">
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
            <CopyButton
              text={adoptCommand}
              className="group flex items-center gap-3 w-full border border-fd-border p-2 px-4 text-sm transition-colors hover:bg-fd-accent cursor-pointer relative bg-fd-muted/10"
            >
              <span className="text-fd-foreground">$ {adoptCommand}</span>
              <span className="ml-auto text-fd-muted-foreground text-xs">on any session</span>
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
              className="inline-flex items-center gap-2 border border-fd-border px-6 py-2.5 text-sm font-mono text-fd-foreground hover:bg-fd-accent transition-colors"
            >
              <span>GitHub</span>
              {stars !== null && (
                <span className="inline-flex items-center gap-1 text-fd-muted-foreground">
                  <span aria-hidden="true">★</span>
                  <span>{formatStars(stars)}</span>
                </span>
              )}
            </a>
          </div>
        </div>

        <TerminalDemo />
      </section>

      <div className="space-y-16 max-w-screen-lg mx-auto px-6">
        {/* THREE-BEAT STORY */}
        <div className="space-y-px bg-fd-border border border-fd-border">
          {beats.map((beat, i) => (
            <div key={beat.kicker} className="bg-fd-background p-6 md:p-8">
              <div className="flex flex-col md:flex-row md:items-start gap-4 md:gap-8">
                <div className="md:w-40 shrink-0">
                  <span className="text-xs text-fd-muted-foreground uppercase tracking-widest">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="text-sm text-fd-primary mt-1">{beat.kicker}</div>
                </div>
                <div className="space-y-2">
                  <h3 className="font-sans text-lg text-fd-foreground">{beat.title}</h3>
                  <p className="text-fd-muted-foreground text-sm leading-normal">{beat.body}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <SectionDivider />

        {/* SURFACE TOUR */}
        <div>
          <h2 className="font-sans text-2xl text-fd-foreground">One app, a keystroke away</h2>
          <p className="text-fd-muted-foreground text-sm mt-1">
            Once a session is adopted, the whole UI is a prefix twin away — reliable under every
            keyboard protocol, with an ⌥ fast-path on top. One grammar, one theme.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 mt-4">
            {surfaces.map((s) => (
              <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]" key={s.title}>
                <div className="p-4 space-y-3">
                  <code className="text-xs text-fd-primary font-mono">{s.key}</code>
                  <h3 className="text-sm text-fd-foreground">{s.title}</h3>
                  <p className="text-fd-muted-foreground text-sm">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <SectionDivider />

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
          <h2 className="font-sans text-2xl text-fd-foreground">From zero to fleet in three commands</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 mt-4">
            {[
              {
                phase: "01",
                title: "Adopt",
                cmd: "tmux-ide adopt work",
                description:
                  "Add the chrome to a session you already have. Fleet tabs, agent glyphs, and triggers appear. Nothing else changes.",
              },
              {
                phase: "02",
                title: "Integrate",
                cmd: "tmux-ide integration install claude",
                description:
                  "Hook Claude Code's lifecycle so working / blocked / done are ground truth. Any agent can self-report the same way.",
              },
              {
                phase: "03",
                title: "Work",
                cmd: "tmux-ide events --follow",
                description:
                  "Glance at the dock, get toasts when an agent needs you, and restore the whole fleet if the server ever dies.",
              },
            ].map((item) => (
              <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]" key={item.phase}>
                <div className="p-4 space-y-3">
                  <span className="text-xs text-fd-muted-foreground uppercase tracking-widest">
                    Step {item.phase}
                  </span>
                  <h3 className="text-sm text-fd-foreground">{item.title}</h3>
                  <code className="block text-xs text-fd-primary font-mono break-all">
                    $ {item.cmd}
                  </code>
                  <p className="text-fd-muted-foreground text-sm">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <SectionDivider />

        {/* SURFACE AREAS — 3-column */}
        <div className="grid grid-cols-1 md:grid-cols-3">
          <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]">
            <div className="p-4 space-y-4">
              <h3 className="text-sm text-fd-foreground">Trust</h3>
              <ul className="text-fd-muted-foreground space-y-2">
                <li className="text-sm">{"◇"} Adopt is just tmux options — reversible</li>
                <li className="text-sm">{"◇"} If tmux-ide dies, plain tmux remains</li>
                <li className="text-sm">{"◇"} Ground-truth status from agent hooks</li>
                <li className="text-sm">{"◇"} agent explain shows exactly why</li>
                <li className="text-sm">{"◇"} User-overridable detection</li>
              </ul>
            </div>
          </div>
          <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]">
            <div className="p-4 space-y-4">
              <h3 className="text-sm text-fd-foreground">Resilience</h3>
              <ul className="text-fd-muted-foreground space-y-2">
                <li className="text-sm">{"◇"} Continuous fleet snapshots</li>
                <li className="text-sm">{"◇"} Restore sessions, windows, layouts</li>
                <li className="text-sm">{"◇"} Cwds and titles come back too</li>
                <li className="text-sm">{"◇"} Revive Claude conversations on resume</li>
                <li className="text-sm">{"◇"} Worktree-per-branch isolation</li>
              </ul>
            </div>
          </div>
          <div className="border border-fd-border p-1 -mt-[1px] -ml-[1px]">
            <div className="p-4 space-y-4">
              <h3 className="text-sm text-fd-foreground">Developer experience</h3>
              <ul className="text-fd-muted-foreground space-y-2">
                <li className="text-sm">{"◇"} One command to adopt</li>
                <li className="text-sm">{"◇"} One grammar: j/k · enter · / · esc · ?</li>
                <li className="text-sm">{"◇"} One theme file for everything</li>
                <li className="text-sm">{"◇"} Renders over SSH, any client</li>
                <li className="text-sm">{"◇"} --json everywhere, open source</li>
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
            <h2 className="font-sans text-2xl sm:text-3xl text-fd-foreground mb-4">Get started</h2>
            <p className="font-sans text-base text-fd-muted-foreground mb-6 max-w-lg mx-auto">
              Keep your terminal. Add the chrome. Adopt a session in seconds.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Link
                href="/docs/getting-started"
                className="bg-fd-primary px-6 py-2.5 text-sm font-mono text-fd-primary-foreground hover:opacity-90 transition-opacity"
              >
                Get started
              </Link>
              <Link
                href="/docs/release-2-6-0"
                className="border border-fd-border px-6 py-2.5 text-sm font-mono text-fd-foreground hover:bg-fd-accent transition-colors"
              >
                What&apos;s new in 2.6
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
