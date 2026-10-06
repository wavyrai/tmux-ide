import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const docsDir = dirname(fileURLToPath(import.meta.url));
// Keep in sync with SITE_URL in lib/site.ts (the canonical host is the apex).
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://tmux-ide.com").replace(
  /\/+$/u,
  "",
);

/** @type {import('next').NextConfig} */
const config = {
  serverExternalPackages: ["@takumi-rs/image-response"],
  reactStrictMode: true,
  transpilePackages: ["geist"],
  turbopack: {
    root: resolve(docsDir, ".."),
  },
  async headers() {
    const securityHeaders = [
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      { key: "X-DNS-Prefetch-Control", value: "on" },
      {
        key: "Permissions-Policy",
        value:
          "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()",
      },
    ];
    // Markdown twins of docs pages point search engines at the HTML page.
    const canonicalLink = (path) => [
      { key: "Link", value: `<${siteUrl}${path}>; rel="canonical"` },
    ];
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/docs/:path+.mdx", headers: canonicalLink("/docs/:path+") },
      { source: "/docs/:path+.md", headers: canonicalLink("/docs/:path+") },
      { source: "/docs.mdx", headers: canonicalLink("/docs") },
      { source: "/docs.md", headers: canonicalLink("/docs") },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/docs/:path*.mdx",
        destination: "/llms.mdx/docs/:path*",
      },
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
};

export default withMDX(config);
