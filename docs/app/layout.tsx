import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { Analytics } from "@vercel/analytics/next";
import { TopBanner } from "@/components/top-banner";
import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tmux.thijsverreck.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "tmux-ide — Prepare Claude agent-team layouts in one terminal",
    template: "%s | tmux-ide",
  },
  description:
    "Prepare Claude Code agent-team-ready tmux layouts with lead and teammate panes plus the right environment setup.",
  keywords: [
    "Claude Code",
    "agent teams",
    "tmux",
    "terminal IDE",
    "Claude",
    "multi-agent",
    "tmux-ide",
    "CLI",
    "developer tools",
    "AI coding",
    "terminal multiplexer",
  ],
  authors: [{ name: "Thijs Verreck", url: "https://thijsverreck.com" }],
  creator: "Thijs Verreck",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "tmux-ide",
    title: "tmux-ide — Prepare Claude agent-team layouts in one terminal",
    description:
      "Prepare Claude Code agent-team-ready tmux layouts with lead and teammate panes plus the right environment setup.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "tmux-ide — Claude agent-team layouts in tmux",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "tmux-ide — Prepare Claude agent-team layouts in one terminal",
    description:
      "Prepare Claude Code agent-team-ready tmux layouts with lead and teammate panes plus the right environment setup.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <TopBanner />
        <RootProvider>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
