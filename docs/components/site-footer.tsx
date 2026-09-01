import Link from "next/link";

import { AppIcon } from "@/components/app-icon";

const links = [
  ["Install", "/docs/getting-started"],
  ["OpenTUI 2.9", "/docs/release-2-9-0-beta-1"],
  ["CLI", "/docs/commands"],
  ["GitHub", "https://github.com/wavyrai/tmux-ide"],
  ["npm", "https://www.npmjs.com/package/tmux-ide"],
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-fd-border">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center">
        <Link href="/" className="flex items-center gap-2 text-fd-foreground">
          <AppIcon size={22} />
          <span className="font-mono text-sm">tmux-ide</span>
        </Link>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 sm:ml-auto">
          {links.map(([label, href]) => (
            <Link
              key={label}
              href={href}
              className="font-mono text-xs text-fd-muted-foreground hover:text-fd-foreground"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
