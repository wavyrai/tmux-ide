import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = dirname(fileURLToPath(import.meta.url));

const isProduction = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const config = {
  // Static export is only enabled for production builds. In `next dev` we let
  // Next handle dynamic routes normally so we can navigate to /project/<name>
  // for any name without enumerating it in generateStaticParams. The fallback
  // trick (single __fallback page + client-side routing) only works when the
  // built `out/` directory is served by the command-center, not by `next dev`.
  ...(isProduction && { output: "export", trailingSlash: true }),
  reactStrictMode: true,
  turbopack: {
    root: resolve(dashboardDir, ".."),
  },
};

export default config;
