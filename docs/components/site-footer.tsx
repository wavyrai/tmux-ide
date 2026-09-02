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
    <footer className="marketing-dark-footer overflow-hidden border-t">
      <MarketingFrame className="footer-frame border-y-0">
        {/* A line-colored canvas owns every internal seam; dark cells repaint
            the surface so adjacent columns can never manufacture double rules. */}
        <div className="footer-rule-grid grid grid-cols-1 gap-px border-b sm:grid-cols-2 lg:grid-cols-5">
          <div className="footer-surface px-6 py-12 sm:col-span-2 lg:py-16 xl:px-10">
            <Link
              href="/"
              aria-label="tmux-ide home"
              className="footer-foreground marketing-logo-action inline-flex items-center gap-3"
            >
              <AppIcon size={30} />
              <AsciiWordmark size="footer" inverted />
            </Link>
            <p className="footer-muted mt-5 max-w-md text-sm leading-6">
              The agent-aware communication plane for building and coordinating a team of coding
              agents on durable tmux sessions.
            </p>
            <code className="footer-foreground mt-7 inline-block font-mono text-xs">
              {INSTALL_COMMAND}
            </code>
          </div>

          {columns.map((column) => (
            <FooterLinkGroup key={column.title} title={column.title} links={column.links} />
          ))}
        </div>

        <div className="footer-rule-grid grid grid-cols-1 gap-px border-b sm:grid-cols-2">
          <div className="footer-muted footer-surface flex items-center gap-2 px-6 py-6 font-mono text-xs xl:px-10">
            <span className="text-emerald-400" aria-hidden>
              ●
            </span>
            <span>Open source · terminal native · SSH ready</span>
          </div>
          <div className="footer-muted footer-surface flex flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-xs sm:justify-end xl:px-10">
            <span>© {new Date().getFullYear()} tmux-ide</span>
            <span>tmux owns the processes. tmux-ide gives them a workspace.</span>
          </div>
        </div>

        <Link
          href="https://www.prototyper.co"
          target="_blank"
          rel="noreferrer"
          aria-label="Prototyper (opens in a new tab)"
          className="footer-foreground footer-surface group block px-4 pt-6 sm:px-6 sm:pt-8 xl:px-8"
        >
          <span className="footer-wordmark marketing-wordmark-action mx-auto block w-[90%] translate-y-[40%]">
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
    <nav className="footer-surface px-6 py-12 lg:py-16" aria-label={`${title} links`}>
      <p className="footer-muted marketing-type-caption font-mono">{title}</p>
      <ul className="mt-6 space-y-3">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link href={href} className="footer-foreground marketing-color-action text-sm">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
