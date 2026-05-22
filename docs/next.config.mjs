import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const docsDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  serverExternalPackages: ["@takumi-rs/image-response"],
  reactStrictMode: true,
  transpilePackages: ["geist"],
  turbopack: {
    root: resolve(docsDir, ".."),
  },
  async rewrites() {
    return [
      {
        source: "/docs/:path*.mdx",
        destination: "/llms.mdx/docs/:path*",
      },
      // The Solid dashboard SPA is built into /public/demo/. Next serves
      // its assets fine but doesn't know about client-side routes like
      // /demo/project/<name>. Rewrite any sub-path (that isn't an asset)
      // to /demo/index.html so the SPA's router picks it up.
      { source: "/demo", destination: "/demo/index.html" },
      { source: "/demo/", destination: "/demo/index.html" },
      {
        source: "/demo/:path((?!assets/|fonts/|.*\\..+$).*)",
        destination: "/demo/index.html",
      },
    ];
  },
};

export default withMDX(config);
