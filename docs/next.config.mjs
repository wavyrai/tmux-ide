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
    ];
  },
};

export default withMDX(config);
