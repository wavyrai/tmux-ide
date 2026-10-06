import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import {
  CURRENT_RELEASE_PATH,
  PUBLISHER_ID,
  PUBLISHER_NAME,
  PUBLISHER_URL,
  SITE_DESCRIPTION,
  SITE_IMAGE,
  SITE_NAME,
  SITE_REPOSITORY,
  SITE_TITLE,
  SITE_URL,
  SOFTWARE_DOWNLOAD_URL,
  SOFTWARE_LICENSE,
  SOFTWARE_VERSION,
  absoluteUrl,
} from "@/lib/site";

const image = {
  url: SITE_IMAGE,
  width: 1200,
  height: 630,
  alt: "tmux-ide — a dedicated workspace for coding agents",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: "%s | tmux-ide",
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "coding agents",
    "agent workspace",
    "agent-aware terminal",
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
  publisher: PUBLISHER_NAME,
  category: "Developer Tools",
  alternates: { canonical: "/" },
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "tmux-ide",
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [image],
  },
  twitter: {
    card: "summary_large_image",
    creator: "@prototyper_co",
    site: "@prototyper_co",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [SITE_IMAGE],
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

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#101016" },
  ],
};

// One entity graph: tmux-ide is an open-source software project published by
// Prototyper. The organization reuses prototyper.co's own @id (where its logo
// and profiles live), so both sites describe the same entity.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": PUBLISHER_ID,
      name: PUBLISHER_NAME,
      url: PUBLISHER_URL,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: absoluteUrl("/"),
      inLanguage: "en",
      publisher: { "@id": PUBLISHER_ID },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: SITE_NAME,
      url: absoluteUrl("/"),
      description: SITE_DESCRIPTION,
      disambiguatingDescription: "tmux-ide, an open-source Prototyper project",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Agent workspace for tmux",
      operatingSystem: "macOS, Linux, and other Unix-like systems",
      softwareRequirements: "tmux",
      softwareVersion: SOFTWARE_VERSION,
      releaseNotes: absoluteUrl(CURRENT_RELEASE_PATH),
      license: SOFTWARE_LICENSE,
      downloadUrl: SOFTWARE_DOWNLOAD_URL,
      installUrl: absoluteUrl("/docs/getting-started"),
      sameAs: [SITE_REPOSITORY, SOFTWARE_DOWNLOAD_URL],
      author: { "@id": PUBLISHER_ID },
      publisher: { "@id": PUBLISHER_ID },
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${SITE_URL}/#source`,
      codeRepository: SITE_REPOSITORY,
      programmingLanguage: "TypeScript",
      license: SOFTWARE_LICENSE,
      targetProduct: { "@id": `${SITE_URL}/#software` },
    },
  ],
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <a
          href="#main-content"
          className="marketing-skip-action fixed left-4 top-4 z-[100] -translate-y-24 rounded-full bg-fd-primary px-4 py-2 text-sm text-fd-primary-foreground shadow-lg focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
        >
          Skip to content
        </a>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</gu, "\\u003c") }}
        />
        {/* Fumadocs owns the global docs/search/theme context. Keep this root
            server component provider-light; page content remains statically rendered. */}
        <RootProvider>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
