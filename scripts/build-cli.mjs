#!/usr/bin/env node
/**
 * Compiles `bin/cli.ts` → `bin/cli.js` using esbuild.
 *
 * Scope (N1 of docs/npm-distribution-audit.md):
 *  - Strip TypeScript so the CLI runs under stock node (no bun, no tsx).
 *  - Inline the project's own `.ts` source (`packages/daemon/src/*.ts`,
 *    workspace silos) into the single bin/cli.js entry. That's the bit
 *    npm-install users cannot resolve themselves — `*.ts` extensions
 *    aren't loadable under node and the published tarball has no
 *    transpile step.
 *  - Keep every third-party / bare-specifier import external. Native
 *    bindings (node-pty, better-sqlite3, @parcel/watcher) and pure-JS
 *    deps alike resolve from `node_modules/` at runtime, the same way
 *    they would in any other published CLI.
 *  - Preserve `#!/usr/bin/env node` as the shebang.
 *
 * Out of scope for N1 (handled by N2):
 *  - Tarball `files` trimming.
 *  - Workspace-package publish strategy (the cli.js bundle still
 *    requires `@tmux-ide/contracts` + friends at runtime; N2 either
 *    flips them public on npm or inlines them too).
 *  - Dashboard `out/` self-contained shape (N3).
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const entry = resolve(repoRoot, "bin", "cli.ts");
const outfile = resolve(repoRoot, "bin", "cli.js");

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Third-party deps (`zod`, `ws`, `node-pty`, `@hono/...`, …) stay
  // external — they're resolved from `node_modules` at runtime. The
  // project's own workspace packages (`@tmux-ide/contracts`,
  // `@tmux-ide/tmux-bridge`, …) are bundled in: pnpm-only `workspace:*`
  // pointers won't resolve under `npm install`, so the bundle is the
  // only sane way to ship our own TS code. Relative `.ts` imports are
  // bundled too — the published tarball has no transpile step.
  plugins: [
    {
      name: "external-non-workspace",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return undefined;
          const id = args.path;
          // Relative paths → bundle (let esbuild walk them).
          if (id.startsWith(".") || id.startsWith("/")) return undefined;
          // node: builtins → external.
          if (id.startsWith("node:")) return { external: true };
          // The pinned headless xterm fork is a release asset, not a workspace
          // package. Bundle it with the Unicode addon: both are pure JS and
          // their named imports are not portable when left bare under stock
          // Node. The stock alias is test-only and must never reach this graph.
          if (id === "@tmux-ide/xterm-headless" || id === "@xterm/addon-unicode11")
            return undefined;
          // Workspace packages → bundle.
          if (id.startsWith("@tmux-ide/")) return undefined;
          // Everything else → external.
          return { external: true };
        });
      },
    },
  ],
  // Standard Hono / better-sqlite3 / node-pty dynamic-require patterns
  // produce noisy esbuild warnings; silence them — they're benign for a
  // CLI that delegates real work to the daemon.
  logLevel: "warning",
  // Keep the shebang on the output. esbuild strips it from the source
  // during bundling, so we add it back via the banner option.
  banner: { js: "#!/usr/bin/env node" },
  // ESM output needs createRequire for any CJS interop the daemon code
  // performs (e.g. better-sqlite3's wrapper).  esbuild's footer injection
  // would be the wrong layer; we leave it to the daemon source.
  sourcemap: false,
  minify: false,
});

// Some bundled CommonJS dependencies contain literal C0 bytes inside string
// constants. They are valid JavaScript, but make git treat the generated CLI
// as binary and violate the package source hygiene gate. Escaping a literal
// byte inside the generated string preserves its runtime value exactly.
const generated = readFileSync(outfile, "utf8");
const disallowedC0Source = String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f]`;
const normalized = generated.replace(
  new RegExp(disallowedC0Source, "gu"),
  (value) => `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`,
);
if (normalized !== generated) writeFileSync(outfile, normalized, "utf8");

// Verify the shebang survived, the file is executable, and there's
// exactly one shebang line — a regression here ships a broken bin.
const compiled = readFileSync(outfile, "utf-8");
if (new RegExp(disallowedC0Source, "u").test(compiled)) {
  throw new Error("[build-cli] generated CLI still contains a disallowed raw control byte");
}
if (!compiled.startsWith("#!/usr/bin/env node\n")) {
  throw new Error(
    `[build-cli] expected node shebang at offset 0, got: ${JSON.stringify(compiled.slice(0, 32))}`,
  );
}
const shebangMatches = compiled.match(/^#!.*$/gm) ?? [];
if (shebangMatches.length !== 1) {
  throw new Error(
    `[build-cli] expected exactly one shebang line, found ${shebangMatches.length}: ${shebangMatches.join(", ")}`,
  );
}
chmodSync(outfile, 0o755);

console.log(`[build-cli] wrote ${outfile} (${statSync(outfile).size} bytes)`);
