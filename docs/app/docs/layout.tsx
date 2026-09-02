import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { SiteFooter } from "@/components/site-footer";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div data-slot="docs-site" className="min-h-screen font-light">
      <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
      <SiteFooter />
    </div>
  );
}
