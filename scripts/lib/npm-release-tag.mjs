import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function npmReleaseTag(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new TypeError(`Invalid release version: ${version}`);
  }

  return version.split("+", 1)[0].includes("-") ? "beta" : "latest";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/lib/npm-release-tag.mjs <version>");
    process.exitCode = 1;
  } else {
    try {
      console.log(npmReleaseTag(version));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
