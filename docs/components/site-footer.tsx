import Link from "next/link";
import { AppIcon } from "@/components/app-icon";
import { PrototyperWordmark } from "@/components/prototyper-wordmark";
import { DITHER_MASK_DOWN, DITHER_SIZE, DITHER_URL, DITHER_URL_INK } from "@/components/dither";

/**
 * The site footer, adapted from the Prototyper marketing footer: a brand column,
 * link columns, and a bottom bar. The difference is what it's built around — the
 * band below the links makes it explicit that tmux-ide is one project in the
 * Prototyper OSS program, rather than leaving that to a logo in the corner.
 *
 * Every link here points at something that exists. No placeholder socials.
 */
const LINKS: Record<string, { label: string; href: string; external?: boolean }[]> = {
  Start: [
    { label: "Getting started", href: "/docs/getting-started" },
    { label: "The dock & keys", href: "/docs/the-dock" },
    { label: "The app", href: "/docs/app-surfaces" },
    { label: "What's new in 2.8", href: "/docs/release-2-8-0" },
  ],
  Agents: [
    { label: "Agent detection", href: "/docs/agent-detection" },
    { label: "Multi-agent teams", href: "/docs/multi-agent-teams" },
    { label: "Notifications & events", href: "/docs/notifications-events" },
    { label: "Restore & resume", href: "/docs/restore-resume" },
  ],
  Reference: [
    { label: "CLI reference", href: "/docs/commands" },
    { label: "ide.yml layouts", href: "/docs/configuration" },
    { label: "Theming & config", href: "/docs/theming" },
    { label: "Templates", href: "/docs/templates" },
  ],
  "Open source": [
    { label: "GitHub", href: "https://github.com/wavyrai/tmux-ide", external: true },
    { label: "npm", href: "https://www.npmjs.com/package/tmux-ide", external: true },
    { label: "Contributing", href: "/docs/contributing" },
    { label: "Prototyper", href: "https://www.prototyper.co", external: true },
    { label: "X", href: "https://x.com/prototyper_co", external: true },
  ],
};

/** The X mark. Inlined rather than pulled from lucide — lucide's `twitter` icon
 *  is still the old bird. */
function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-fd-border">
      <div className="mx-auto max-w-screen-xl px-6 pt-14 pb-10">
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
          {/* Brand */}
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link href="/" className="flex items-center gap-2" aria-label="tmux-ide — home">
              <AppIcon size={22} />
              <span className="font-pixel text-lg text-fd-foreground">tmux-ide</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fd-muted-foreground">
              The terminal that understands your agents. A terminal-native agent cockpit built
              around the tmux you already run — adopt in place, unadopt to revert.
            </p>
          </div>

          {Object.entries(LINKS).map(([group, links]) => (
            <div key={group}>
              <h4 className="font-mono text-xs lowercase tracking-widest text-fd-muted-foreground/60">
                {group}
              </h4>
              <ul className="mt-4 space-y-2.5">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      {...(link.external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
                      className="text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* THE OSS BAND — the point of this footer. Dithered like the top banner so
        the two Prototyper surfaces bookend the page, but theme-aware: the cells
        are INK on a light surface and WHITE on a dark one. Swapped by the theme
        class, not by JS, so there's no flash on first paint. */}
      <div className="relative isolate overflow-hidden border-t border-fd-border bg-fd-muted/40">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 block dark:hidden"
          style={{
            backgroundImage: DITHER_URL_INK,
            backgroundSize: DITHER_SIZE,
            maskImage: DITHER_MASK_DOWN,
            WebkitMaskImage: DITHER_MASK_DOWN,
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 hidden dark:block"
          style={{
            backgroundImage: DITHER_URL,
            backgroundSize: DITHER_SIZE,
            maskImage: DITHER_MASK_DOWN,
            WebkitMaskImage: DITHER_MASK_DOWN,
          }}
        />
        <div className="mx-auto flex max-w-screen-xl flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <Link
              href="https://www.prototyper.co"
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 text-fd-foreground transition-opacity hover:opacity-80"
            >
              <PrototyperWordmark width={104} />
              <span className="font-mono text-[10px] tracking-[0.22em] text-fd-muted-foreground">
                oss
              </span>
            </Link>
            <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
              tmux-ide is part of <span className="text-fd-foreground">Prototyper OSS</span> — the
              open tools we build in the open while building Prototyper. Free, MIT-licensed, and
              yours to fork: no account, no telemetry, no lock-in.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <Link
              href="https://x.com/prototyper_co"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Prototyper on X"
              className="flex h-[34px] w-[34px] items-center justify-center border border-fd-border bg-fd-background text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
            >
              <XIcon />
            </Link>
            <Link
              href="https://github.com/wavyrai/tmux-ide"
              target="_blank"
              rel="noreferrer noopener"
              // Filled with the page surface (white in light, black in dark) so it
              // reads as a solid button on the dithered band rather than a hole in it.
              className="border border-fd-border bg-fd-background px-4 py-2 font-mono text-xs text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              Star on GitHub
            </Link>
            <Link
              href="https://www.prototyper.co"
              target="_blank"
              rel="noreferrer noopener"
              className="border border-fd-foreground bg-fd-foreground px-4 py-2 font-mono text-xs text-fd-background transition-opacity hover:opacity-90"
            >
              Prototyper ↗
            </Link>
          </div>
        </div>

        <div className="mx-auto flex max-w-screen-xl flex-col items-start justify-between gap-3 border-t border-fd-border px-6 py-5 text-xs text-fd-muted-foreground sm:flex-row sm:items-center">
          <span>
            © {year} Prototyper · tmux-ide is MIT-licensed · built by{" "}
            <Link
              href="https://thijsverreck.com"
              target="_blank"
              rel="noreferrer noopener"
              className="transition-colors hover:text-fd-foreground"
            >
              Thijs Verreck
            </Link>
          </span>
          <div className="flex items-center gap-5">
            <Link
              href="https://github.com/wavyrai/tmux-ide/blob/main/LICENSE"
              target="_blank"
              rel="noreferrer noopener"
              className="transition-colors hover:text-fd-foreground"
            >
              License
            </Link>
            <Link href="/docs" className="transition-colors hover:text-fd-foreground">
              Docs
            </Link>
            <Link
              href="https://github.com/wavyrai/tmux-ide/issues"
              target="_blank"
              rel="noreferrer noopener"
              className="transition-colors hover:text-fd-foreground"
            >
              Issues
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
