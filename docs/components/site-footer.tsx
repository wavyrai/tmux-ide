import Link from "next/link";

import { AppIcon } from "@/components/app-icon";
import { AsciiWordmark } from "@/components/ascii-wordmark";
import { MarketingFrame } from "@/components/marketing/lattice";
import { PrototyperWordmark } from "@/components/prototyper-wordmark";
import { INSTALL_COMMAND } from "@/lib/site";

const columns = [
  {
    title: "Learn",
    links: [
      ["Getting started", "/docs/getting-started"],
      ["Documentation", "/docs"],
      ["TUI demo", "/docs/demo"],
      ["CLI reference", "/docs/commands"],
    ],
  },
  {
    title: "Agent workspace",
    links: [
      ["Agent detection", "/docs/agent-detection"],
      ["Agent teams", "/docs/multi-agent-teams"],
      ["Configuration", "/docs/configuration"],
      ["Restore & resume", "/docs/restore-resume"],
    ],
  },
  {
    title: "Community",
    links: [
      ["GitHub", "https://github.com/wavyrai/tmux-ide"],
      ["npm package", "https://www.npmjs.com/package/tmux-ide"],
      ["Contributing", "/docs/contributing"],
      ["X · @prototyper_co", "https://x.com/prototyper_co"],
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="marketing-dark-footer overflow-hidden border-t border-marketing-line bg-marketing-paper">
      <MarketingFrame className="border-y-0">
        {/* A line-colored canvas owns every internal seam; dark cells repaint
            the surface so adjacent columns can never manufacture double rules. */}
        <div className="grid grid-cols-1 gap-px border-b border-marketing-line bg-marketing-line sm:grid-cols-2 lg:grid-cols-5">
          <div className="bg-marketing-paper px-6 py-12 sm:col-span-2 lg:py-16 xl:px-10">
            <Link
              href="/"
              aria-label="tmux-ide home"
              className="marketing-logo-action inline-flex items-center gap-3 text-fd-foreground"
            >
              <AppIcon size={30} />
              <AsciiWordmark size="footer" inverted />
            </Link>
            <p className="mt-5 max-w-md text-sm leading-6 text-fd-muted-foreground">
              The agent-aware communication plane for building and coordinating a team of coding
              agents on durable tmux sessions.
            </p>
            <code className="mt-7 inline-block font-mono text-xs text-fd-foreground">
              {INSTALL_COMMAND}
            </code>
          </div>

          {columns.map((column) => (
            <FooterLinkGroup key={column.title} title={column.title} links={column.links} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-px border-b border-marketing-line bg-marketing-line sm:grid-cols-2">
          <div className="flex items-center gap-2 bg-marketing-paper px-6 py-6 font-mono text-xs text-fd-muted-foreground xl:px-10">
            <span className="text-emerald-400" aria-hidden>
              ●
            </span>
            <span>Open source · terminal native · SSH ready</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-marketing-paper px-6 py-6 text-xs text-fd-muted-foreground sm:justify-end xl:px-10">
            <span>© {new Date().getFullYear()} tmux-ide</span>
            <span>tmux owns the processes. tmux-ide gives them a workspace.</span>
          </div>
        </div>

        <Link
          href="https://www.prototyper.co"
          target="_blank"
          rel="noreferrer"
          aria-label="Prototyper (opens in a new tab)"
          className="group block bg-marketing-paper px-4 pt-6 text-fd-foreground sm:px-6 sm:pt-8 xl:px-8"
        >
          <span className="marketing-wordmark-action mx-auto block w-[90%] translate-y-[40%] text-white/32">
            <PrototyperWordmark width="100%" outline className="block h-auto w-full" />
          </span>
        </Link>
      </MarketingFrame>
    </footer>
  );
}

function FooterLinkGroup({
  title,
  links,
}: {
  title: string;
  links: readonly (readonly [string, string])[];
}) {
  return (
    <nav className="bg-marketing-paper px-6 py-12 lg:py-16" aria-label={`${title} links`}>
      <p className="marketing-type-caption font-mono text-fd-muted-foreground">{title}</p>
      <ul className="mt-6 space-y-3">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link href={href} className="marketing-color-action text-sm text-fd-foreground">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
