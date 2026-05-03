import type { Metadata } from "next";
import { Providers } from "@/components/Providers";
import { ShellSidebarProvider } from "@/components/ShellSidebarProvider";
import { TopBar } from "@/components/TopBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "tmux-ide",
  description: "Command center for tmux-ide",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="min-h-screen bg-[var(--bg)] text-[var(--fg)] antialiased text-[13px] leading-[1.5]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <Providers>
          <ShellSidebarProvider>
            <TopBar />
            {children}
          </ShellSidebarProvider>
        </Providers>
      </body>
    </html>
  );
}
