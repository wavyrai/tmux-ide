import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @type {import("eslint").Linter.Config[]} */
const nextConfig = require("eslint-config-next/core-web-vitals");

/** React 19 / Compiler rules in eslint-plugin-react-hooks v7 flag many valid patterns (hydration guards, ref indirection, polling). Re-enable incrementally. */
const config = [
  ...nextConfig,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
];

export default config;
