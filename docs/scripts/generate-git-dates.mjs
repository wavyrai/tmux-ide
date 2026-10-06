import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentDir, docsDir, homeSources } from "./git-date-sources.mjs";

// Source-backed modification dates for sitemap <lastmod> and dateModified,
// computed once at build time so server code never touches git or the
// filesystem (dynamic fs access makes Next trace the whole project).
//
// A date is the committer time of the last commit touching the source. In a
// shallow clone the boundary commit looks like it touched every file, so a date
// that comes from a boundary commit is unknown and left out rather than guessed.
// Full history on the build host (e.g. VERCEL_DEEP_CLONE=true) dates every page.

const outputPath = resolve(docsDir, ".source/git-dates.json");

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: docsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const boundary = new Set();
const shallowFile = git(["rev-parse", "--path-format=absolute", "--git-path", "shallow"]);
if (shallowFile && existsSync(shallowFile)) {
  for (const line of readFileSync(shallowFile, "utf8").split("\n")) {
    if (line.trim()) boundary.add(line.trim());
  }
}
/** Date of the last commit touching `paths`, or null when history cannot back it. */
function lastCommitDate(paths) {
  const [hash, iso] = (git(["log", "-1", "--format=%H %cI", "--", ...paths]) ?? "").split(" ");
  if (!hash || boundary.has(hash) || Number.isNaN(Date.parse(iso))) return null;
  return new Date(iso).toISOString();
}

const pages = {};
for (const file of readdirSync(resolve(docsDir, contentDir), { recursive: true })) {
  if (/\.mdx?$/u.test(file)) pages[file] = lastCommitDate([`${contentDir}/${file}`]);
}

const dates = {
  home: lastCommitDate(homeSources),
  pages: Object.fromEntries(
    Object.entries(pages)
      .filter(([, date]) => date !== null)
      .sort(),
  ),
};
mkdirSync(resolve(docsDir, ".source"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(dates, null, 2)}\n`);
console.log(
  `Git dates: ${Object.keys(dates.pages).length} docs pages${dates.home ? " + homepage" : ""}` +
    `${boundary.size ? " (shallow clone: undatable pages omitted)" : ""}`,
);
