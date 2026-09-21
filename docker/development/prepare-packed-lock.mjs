/* global process */
/** Bind a frozen dependency lock to the exact locally packed artifact. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const [packageJson, tarball, lockFile, destination] = process.argv.slice(2);
if (!destination)
  throw new Error(
    "Usage: prepare-packed-lock.mjs <package-json> <tarball> <lock> <new-destination>",
  );
const source = JSON.parse(readFileSync(packageJson, "utf8"));
const lock = JSON.parse(readFileSync(lockFile, "utf8"));
const entry = lock.packages?.["node_modules/tmux-ide"];
const ordered = (value) =>
  JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
if (
  source.name !== "tmux-ide" ||
  lock.lockfileVersion !== 3 ||
  !entry ||
  [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "engines",
    "bin",
  ].some((key) => ordered(entry[key]) !== ordered(source[key])) ||
  entry.license !== source.license ||
  entry.hasInstallScript !==
    Boolean(source.scripts?.install || source.scripts?.postinstall || source.scripts?.preinstall)
)
  throw new Error(
    "Packed runtime dependencies changed: explicitly refresh and review fixture lock",
  );
mkdirSync(destination, { mode: 0o700 });
entry.version = source.version;
const bytes = readFileSync(tarball);
entry.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
writeFileSync(join(destination, "tmux-ide.tgz"), bytes, { flag: "wx" });
writeFileSync(
  join(destination, "package.json"),
  JSON.stringify(
    {
      name: "tmux-ide-packed-fixture",
      version: "1.0.0",
      private: true,
      dependencies: { "tmux-ide": "file:./tmux-ide.tgz" },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(join(destination, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
