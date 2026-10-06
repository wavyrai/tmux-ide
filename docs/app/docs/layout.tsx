import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { SiteFooter } from "@/components/site-footer";
import { TopBanner } from "@/components/top-banner";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div data-slot="docs-site" className="min-h-screen">
      {/* The banner height feeds Fumadocs' --fd-banner-height row (global.css),
          so the sticky sidebar, TOC and mobile header stack below it. */}
      <TopBanner />
      <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
      <SiteFooter />
    </div>
  );
}
