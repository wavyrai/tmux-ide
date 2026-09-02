const VERSION_ALIGNMENT_PATHS = new Set([
  "bin/cli.js",
  "package.json",
  "packages/daemon/package.json",
]);

export function releaseSourceState(porcelain) {
  const paths = porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      const rename = path.lastIndexOf(" -> ");
      return rename === -1 ? path : path.slice(rename + 4);
    });
  if (paths.length === 0) return "clean";
  if (paths.every((path) => VERSION_ALIGNMENT_PATHS.has(path))) return "version-aligned";
  return "dirty";
}

export function assertCleanEvidenceSource(state) {
  if (state !== "clean") {
    throw new Error(
      `Exact packaged evidence requires a clean checkout; source state is ${state}. ` +
        "Commit the qualification slice, then rerun the evidence command from that exact SHA.",
    );
  }
}
