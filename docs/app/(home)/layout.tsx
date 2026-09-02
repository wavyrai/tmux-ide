import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import { SiteFooter } from "@/components/site-footer";
import { TopBanner } from "@/components/top-banner";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="marketing-home"
      className="flex min-h-screen flex-col overflow-x-clip font-light"
    >
      <TopBanner />
      <HomeLayout {...baseOptions()}>
        {children}
        {/* Marketing pages only — the docs layout has its own footer chrome. */}
        <SiteFooter />
      </HomeLayout>
    </div>
  );
}
