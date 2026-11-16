// Decides whether the release's "Bump Homebrew tap" job has work to do, and
// fails the job when it has work it cannot do. Prints step outputs on stdout.
import { pathToFileURL } from "node:url";

import { npmReleaseTag } from "./npm-release-tag.mjs";

export function tapBumpGate({ version, hasToken }) {
  const tag = npmReleaseTag(version);
  if (tag !== "latest")
    return {
      enabled: false,
      note: `Prerelease v${version} uses npm dist-tag '${tag}'; leaving stable Homebrew unchanged.`,
    };
  if (!hasToken)
    throw new Error(
      `TAP_PUSH_TOKEN is not set, so wavyrai/homebrew-tap was not bumped to v${version} and ` +
        "`brew install wavyrai/tap/tmux-ide` still installs the old version. " +
        "Add the secret (packaging/homebrew/README.md), then re-run this job.",
    );
  return { enabled: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] ?? "";
  try {
    const gate = tapBumpGate({ version, hasToken: Boolean(process.env.TAP_PUSH_TOKEN?.trim()) });
    if (gate.note) console.error(gate.note);
    console.log(`version=${version}\nenabled=${gate.enabled}`);
  } catch (error) {
    console.error(`::error title=Homebrew tap not bumped::${error.message}`);
    process.exitCode = 1;
  }
}
