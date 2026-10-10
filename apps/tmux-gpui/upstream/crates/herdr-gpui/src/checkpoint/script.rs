//! The Git side of checkpoints, as POSIX shell scripts that run in the
//! checkout's own host, locally or over SSH.
//!
//! A checkpoint is a commit whose tree is the whole working tree, untracked
//! (not ignored) files included, and whose parent is the `HEAD` it was taken
//! on. It is built through a temporary copy of the index, so the checkout's
//! real index, branch, and files are never touched by taking one. Each
//! checkpoint lives under a hidden ref named for the branch it was taken on.
//! Per-worktree `refs/worktree/` would be tidier, but `git gc` run from
//! another worktree does not keep their objects, so it could delete them.

use super::{Checkout, Checkpoint, Diff};
use crate::{Error, Result};
use herdr_client::shell_quote;

/// Hidden from branch and tag listings; one directory per branch, named by
/// the hash of its name so `a` never lists `a/b`'s checkpoints.
pub(super) const NAMESPACE: &str = "refs/herdr-gpui/checkpoints/";
/// Trailer naming the branch a checkpoint was taken on; restore refuses to
/// move any other branch to its commit.
const BRANCH_TRAILER: &str = "Herdr-Branch: ";
const RECORD: char = '\u{1e}';
/// Longest label kept in a commit message.
const LABEL_LIMIT: usize = 200;

/// Exit statuses the scripts use for refusals the user can act on.
const EXIT_NO_CHECKOUT: i32 = 65;
const EXIT_UNBORN: i32 = 66;
const EXIT_MISSING: i32 = 67;
const EXIT_BRANCH: i32 = 68;
const EXIT_BUSY: i32 = 69;

/// Strict mode, a `PATH` that finds Git in a non-interactive SSH shell, Git
/// without filesystem monitor hooks, and the checkout located by branch from
/// the repository's own worktree registry rather than from any pane's cwd.
fn prelude(checkout: &Checkout) -> String {
    format!(
        r#"set -eu
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.nix-profile/bin"
export PATH
# Never prefix `g` with an assignment: before a function call, bash's POSIX
# mode (macOS /bin/sh) keeps it set afterwards, so a temporary index would
# leak into every later command. Such calls run `git` directly instead.
g() {{ git -c core.fsmonitor=false "$@"; }}
key={key}
branch={branch}
namespace={namespace}$(printf '%s' "$branch" | g hash-object --stdin)/
checkout=$(g --git-dir "$key" worktree list --porcelain | ref="refs/heads/$branch" awk '
    substr($0, 1, 9) == "worktree " {{ path = substr($0, 10) }}
    $0 == "branch " ENVIRON["ref"] {{ print path; exit }}')
[ -n "$checkout" ] || exit {EXIT_NO_CHECKOUT}
cd -- "$checkout"
"#,
        key = shell_quote(&checkout.repo_key),
        branch = shell_quote(&checkout.branch),
        namespace = shell_quote(NAMESPACE),
    )
}

/// Defines `capture LABEL STAMP KEEP`: snapshots the working tree, skips a
/// snapshot identical to the latest one, then keeps only the newest `KEEP`.
/// Leaves `$tree` (the working tree's tree) and `$tmp` (an index of it) set.
/// `66` is [`EXIT_UNBORN`]: a checkout with no commit has nothing to anchor to.
const CAPTURE: &str = r#"
head=$(g rev-parse -q --verify 'HEAD^{commit}') || exit 66
tmp=$(mktemp "${TMPDIR:-/tmp}/herdr-checkpoint.XXXXXX")
trap 'rm -f "$tmp"' EXIT
index=$(g rev-parse --git-path index)
# Starting from the real index keeps its stat cache, so unchanged files are
# not hashed again. Git replaces the index by rename, so the copy is whole.
if [ -f "$index" ]; then cp "$index" "$tmp"; else rm -f "$tmp"; fi
capture() {
    GIT_INDEX_FILE="$tmp" git -c core.fsmonitor=false add -A
    tree=$(GIT_INDEX_FILE="$tmp" git -c core.fsmonitor=false write-tree)
    latest=$(g for-each-ref --count=1 --sort=-refname --format='%(objectname)' "$namespace")
    if [ -n "$latest" ] \
        && [ "$(g rev-parse "$latest^{tree}")" = "$tree" ] \
        && [ "$(g rev-parse "$latest^")" = "$head" ]; then
        printf 'unchanged\n'
    else
        commit=$(printf '%s\n\nHerdr-Branch: %s\n' "$1" "$branch" \
            | GIT_AUTHOR_NAME='Herdr GPUI' GIT_AUTHOR_EMAIL='herdr-gpui@localhost' \
              GIT_COMMITTER_NAME='Herdr GPUI' GIT_COMMITTER_EMAIL='herdr-gpui@localhost' \
              git -c core.fsmonitor=false commit-tree --no-gpg-sign -p "$head" "$tree")
        g update-ref -m 'herdr-gpui: checkpoint' "$namespace$2" "$commit" ''
        printf 'created %s\n' "$2"
    fi
    g for-each-ref --sort=-refname --format='%(refname)' "$namespace" \
        | tail -n "+$(($3 + 1))" \
        | while IFS= read -r old; do g update-ref -d "$old"; done
}
"#;

/// Snapshot the checkout as a new checkpoint named `stamp`, keeping `keep`.
pub(super) fn capture(checkout: &Checkout, label: &str, stamp: &str, keep: usize) -> String {
    format!(
        "{}{CAPTURE}capture {} {} {keep}\n",
        prelude(checkout),
        shell_quote(&clean_label(label)),
        shell_quote(stamp),
    )
}

/// List the checkout's checkpoints, oldest first, each with what changed
/// since the one before it (the first: since the commit it was taken on).
pub(super) fn list(checkout: &Checkout) -> String {
    format!(
        r#"{}previous=
g for-each-ref --sort=refname --format='%(refname:lstrip=4) %(objectname)' "$namespace" \
    | while read -r id commit; do
        base=${{previous:-$commit^}}
        stats=$(g diff --no-ext-diff --numstat "$base" "$commit" \
            | awk '{{ f++; if ($1 != "-") a += $1; if ($2 != "-") d += $2 }}
                   END {{ printf "%d %d %d", f, a, d }}')
        printf '\036%s\n%s\n' "$id" "$stats"
        g log -1 --format='%ct%n%B' "$commit"
        previous=$commit
    done
"#,
        prelude(checkout)
    )
}

/// Put the checkout back to checkpoint `id`: its files, with `HEAD` on the
/// commit the checkpoint was taken on. The current state is captured first
/// (as `stamp`), so a restore can itself be undone.
pub(super) fn restore(
    checkout: &Checkout,
    id: &str,
    label: &str,
    stamp: &str,
    keep: usize,
) -> String {
    format!(
        r#"{prelude}target=$(g rev-parse -q --verify "$namespace"{id}'^{{commit}}') || exit {EXIT_MISSING}
recorded=$(g log -1 --format=%B "$target" | sed -n 's/^{BRANCH_TRAILER}//p' | head -n 1)
[ "$recorded" = "$branch" ] || exit {EXIT_BRANCH}
for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
    [ ! -e "$(g rev-parse --git-path "$state")" ] || exit {EXIT_BUSY}
done
{CAPTURE}capture {label} {stamp} {keep}
# The temporary index matches the working tree exactly, so a two-tree merge
# moves every file to the checkpoint's and deletes those it did not have.
GIT_INDEX_FILE="$tmp" git -c core.fsmonitor=false read-tree -m -u "$tree" "$target^{{tree}}"
g reset -q "$target^"
"#,
        prelude = prelude(checkout),
        id = shell_quote(id),
        label = shell_quote(&clean_label(label)),
        stamp = shell_quote(stamp),
    )
}

/// One line, no control characters, bounded: a label is untrusted daemon text.
fn clean_label(label: &str) -> String {
    let label: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(LABEL_LIMIT)
        .collect();
    let label = label.trim();
    if label.is_empty() {
        "Checkpoint".to_owned()
    } else {
        label.to_owned()
    }
}

/// The checkpoint `capture` created, or none when nothing had changed.
pub(super) fn parse_capture(output: &str) -> Result<Option<String>> {
    let line = output.lines().next_back().unwrap_or_default();
    if line == "unchanged" {
        return Ok(None);
    }
    line.strip_prefix("created ")
        .filter(|id| valid_id(id))
        .map(|id| Some(id.to_owned()))
        .ok_or(Error::CheckpointOutput)
}

/// Checkpoints newest first.
pub(super) fn parse_list(output: &str) -> Result<Vec<Checkpoint>> {
    let mut checkpoints = Vec::new();
    for record in output.split(RECORD).skip(1) {
        let mut lines = record.lines();
        let id = lines.next().filter(|id| valid_id(id));
        let stats: Vec<u64> = lines
            .next()
            .unwrap_or_default()
            .split(' ')
            .filter_map(|field| field.parse().ok())
            .collect();
        let created = lines.next().and_then(|time| time.parse::<i64>().ok());
        let (Some(id), [files, additions, deletions], Some(created)) =
            (id, stats.as_slice(), created)
        else {
            return Err(Error::CheckpointOutput);
        };
        let label = lines.next().unwrap_or_default().to_owned();
        let branch = lines
            .find_map(|line| line.strip_prefix(BRANCH_TRAILER))
            .map(str::to_owned);
        checkpoints.push(Checkpoint {
            id: id.to_owned(),
            created,
            label,
            branch,
            diff: Diff {
                files: *files,
                additions: *additions,
                deletions: *deletions,
            },
        });
    }
    checkpoints.reverse();
    Ok(checkpoints)
}

/// Stamps are the only ids this client creates: digits, so they are safe in a
/// ref name and sort by age.
pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())
}

/// Classify a failed script by the refusals it reports through its status.
pub(super) fn classify(error: herdr_client::Error) -> Error {
    if let herdr_client::Error::ScriptExit { status, .. } = &error {
        match status.code() {
            Some(EXIT_NO_CHECKOUT) => return Error::CheckpointCheckout,
            Some(EXIT_UNBORN) => return Error::CheckpointUnborn,
            Some(EXIT_MISSING) => return Error::CheckpointMissing,
            Some(EXIT_BRANCH) => return Error::CheckpointBranch,
            Some(EXIT_BUSY) => return Error::CheckpointBusy,
            _ => {}
        }
    }
    Error::CheckpointScript(error)
}

#[cfg(test)]
#[path = "script_tests.rs"]
mod tests;
