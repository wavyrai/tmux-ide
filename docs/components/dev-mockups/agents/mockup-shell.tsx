import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { TopBanner } from "@/components/top-banner";
import { baseOptions } from "@/lib/layout.shared";

/**
 * The marketing chrome of app/(home)/layout.tsx around a /dev design mockup,
 * plus a strip that names the mockup and its card. /dev routes sit outside the
 * (home) group, so they do not inherit its layout.
 */
export function MockupShell({ card, children }: { card: string; children: ReactNode }) {
  return (
    <div data-slot="marketing-home" className="flex min-h-screen flex-col overflow-x-clip">
      <TopBanner />
      <HomeLayout {...baseOptions()}>
        <p className="type-caption-1 border-b border-marketing-line bg-marketing-panel px-(--site-gutter) py-2 text-center text-fd-muted-foreground">
          Design mockup for card {card}. Not linked from the site, not indexed, and a 404 on
          tmux-ide.com.
        </p>
        {children}
        <SiteFooter />
      </HomeLayout>
    </div>
  );
}
