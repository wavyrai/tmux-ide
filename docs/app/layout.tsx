import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tmux.thijsverreck.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "tmux-ide — a visual tmux client for coding agents",
    template: "%s | tmux-ide",
  },
  description:
    "A mouse-friendly OpenTUI for ordinary tmux sessions, with agent status, pane and window controls, durable sessions, and SSH support.",
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
    title: "tmux-ide — a visual tmux client for coding agents",
    description:
      "A mouse-friendly OpenTUI for ordinary tmux sessions, with agent-aware chrome and no multiplexer lock-in.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "tmux-ide — visual tmux client for coding agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "tmux-ide — a visual tmux client for coding agents",
    description:
      "A mouse-friendly OpenTUI for ordinary tmux sessions, with agent-aware chrome and no multiplexer lock-in.",
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
        <RootProvider>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
