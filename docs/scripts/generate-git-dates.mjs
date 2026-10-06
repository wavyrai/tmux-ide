import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-backed modification dates for sitemap <lastmod> and dateModified,
// computed once at build time so server code never touches git or the
// filesystem (dynamic fs access makes Next trace the whole project).
//
// A date is the committer time of the last commit touching the source. In a
// shallow clone the boundary commit looks like it touched every file, so a date
// that comes from a boundary commit is unknown and left out rather than guessed.
// Full history on the build host (e.g. VERCEL_DEEP_CLONE=true) dates every page.

const docsDir = resolve(import.meta.dirname, "..");
const outputPath = resolve(docsDir, ".source/git-dates.json");
const contentDir = "content/docs";
/** Sources that render the marketing homepage. */
const homeSources = ["app/(home)", "lib/landing-content.ts", "components/marketing"];

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: docsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
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
const prefix = git(["rev-parse", "--show-prefix"]) ?? "";

/** The commit date if it is backed by history, else null. */
function datedCommit(hash, iso) {
  if (!hash || boundary.has(hash) || Number.isNaN(Date.parse(iso))) return null;
  return new Date(iso).toISOString();
}

const pages = {};
const log = git(["log", "--format=commit %H %cI", "--name-only", "--", contentDir]) ?? "";
let commit = null;
for (const line of log.split("\n")) {
  if (line.startsWith("commit ")) {
    const [, hash, iso] = line.split(" ");
    commit = { hash, iso };
  } else if (line && commit && line.startsWith(prefix)) {
    const path = line.slice(prefix.length).slice(contentDir.length + 1);
    // The newest commit touching a file decides; an undatable one stays null.
    const isPage = /\.mdx?$/u.test(path) && existsSync(resolve(docsDir, contentDir, path));
    if (isPage && !(path in pages)) {
      pages[path] = datedCommit(commit.hash, commit.iso);
    }
  }
}

const [homeHash, homeIso] = (
  git(["log", "-1", "--format=%H %cI", "--", ...homeSources]) ?? ""
).split(" ");

const dates = {
  home: datedCommit(homeHash, homeIso),
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
