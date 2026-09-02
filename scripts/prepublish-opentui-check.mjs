#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cliJsPath = join(root, "bin", "cli.js");
const cliTsPath = join(root, "bin", "cli.ts");
if (!existsSync(cliJsPath) || !existsSync(cliTsPath)) {
  throw new Error("OpenTUI publish boundary is missing bin/cli.ts or its compiled bin/cli.js");
}
if (statSync(cliJsPath).mtimeMs < statSync(cliTsPath).mtimeMs) {
  throw new Error("bin/cli.js is stale — run `pnpm build:cli` before publishing OpenTUI");
}

const bundle = readFileSync(cliJsPath, "utf8");
if (bundle.includes("production-web-server")) {
  throw new Error("OpenTUI CLI bundle still contains the deferred production Web GUI server");
}
if (!bundle.includes("The Web GUI is not included in the OpenTUI beta")) {
  throw new Error("OpenTUI CLI bundle is missing its honest deferred-Web boundary");
}

process.stdout.write("[prepublish:opentui] compiled CLI boundary passed\n");
