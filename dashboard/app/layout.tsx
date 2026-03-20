import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "tmux-ide Dashboard",
  description: "Multi-project command center for tmux-ide",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={ibmPlexMono.variable}>
      <body
        className="min-h-screen bg-[#131010] text-[#e8e4e4] antialiased"
        style={{ fontFamily: "var(--font-mono), ui-monospace, monospace" }}
      >
        <header className="h-12 border-b border-[rgba(255,255,255,0.06)] flex items-center px-6 bg-[#1a1717] sticky top-0 z-10">
          <div className="flex items-center gap-3 flex-1">
            <span className="text-sm text-[#dcde8d] font-medium">
              tmux-ide
            </span>
            <span className="text-[#6b6363] text-sm">dashboard</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
