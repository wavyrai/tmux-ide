import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: {
    root: resolve(dashboardDir, ".."),
  },
};

export default config;
