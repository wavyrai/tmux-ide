//! What a fan-out asks for: the agents picked, the branch and agent name each
//! lane gets, and how a lane's changes are read and summarized. Pure, so it
//! is tested without a host.

use crate::teleport::AgentKind;
use herdr_client::shell_quote;

/// The most lanes one fan-out starts: each is a checkout and a running agent.
pub(crate) const MAX_LANES: usize = 6;

/// Branches of one fan-out share this namespace and a generated stem.
const PREFIX: &str = "fan-out";

/// How many lanes of each agent kind are picked, in the order first picked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Picks(Vec<(AgentKind, usize)>);

impl Picks {
    pub(crate) fn count(&self, kind: AgentKind) -> usize {
        self.0
            .iter()
            .find(|(picked, _)| *picked == kind)
            .map_or(0, |(_, count)| *count)
    }

    pub(crate) fn total(&self) -> usize {
        self.0.iter().map(|(_, count)| count).sum()
    }

    /// Each lane's agent kind, in lane order: [`lanes`] follows it too.
    pub(crate) fn kinds(&self) -> impl Iterator<Item = AgentKind> + '_ {
        self.0
            .iter()
            .flat_map(|(kind, count)| std::iter::repeat_n(*kind, *count))
    }

    /// Add a lane of `kind`, unless the fan-out is already full.
    pub(crate) fn add(&mut self, kind: AgentKind) -> bool {
        if self.total() >= MAX_LANES {
            return false;
        }
        match self.0.iter_mut().find(|(picked, _)| *picked == kind) {
            Some((_, count)) => *count += 1,
            None => self.0.push((kind, 1)),
        }
        true
    }

    /// Drop one lane of `kind`, if any is picked.
    pub(crate) fn remove(&mut self, kind: AgentKind) -> bool {
        let Some(index) = self.0.iter().position(|(picked, _)| *picked == kind) else {
            return false;
        };
        self.0[index].1 -= 1;
        if self.0[index].1 == 0 {
            self.0.remove(index);
        }
        true
    }
}

/// One agent's share of a fan-out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Lane {
    pub(crate) kind: AgentKind,
    pub(crate) branch: String,
    /// The Herdr agent name, unique to this lane.
    pub(crate) agent: String,
}

/// One lane per pick, all named after `seed` so a fan-out's branches sort
/// together: `fan-out/calm-river-1a2b-claude`, then `...-claude-2` for a
/// second lane of the same agent.
pub(crate) fn lanes(picks: &Picks, seed: u64) -> Vec<Lane> {
    let generated = crate::worktree::generated_branch_slug(seed);
    let stem = generated
        .split_once('/')
        .map_or(generated.as_str(), |(_, stem)| stem);
    let mut lanes = Vec::with_capacity(picks.total());
    for (kind, count) in &picks.0 {
        for number in 1..=*count {
            let agent = match number {
                1 => format!("{stem}-{}", kind.name()),
                _ => format!("{stem}-{}-{number}", kind.name()),
            };
            lanes.push(Lane {
                kind: *kind,
                branch: format!("{PREFIX}/{agent}"),
                agent,
            });
        }
    }
    lanes
}

/// What one lane changed relative to the fan-out's base commit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DiffStat {
    /// Tracked files differing from the base, committed or not.
    pub(crate) files: u64,
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
    pub(crate) untracked: u64,
    /// Commits on the lane's branch since the base.
    pub(crate) commits: u64,
}

impl DiffStat {
    pub(crate) fn summary(&self) -> String {
        if *self == Self::default() {
            return "No changes yet".to_owned();
        }
        let plural = |count: u64, one: &str, many: &str| {
            format!("{count} {}", if count == 1 { one } else { many })
        };
        let mut parts = vec![format!("+{} −{}", self.additions, self.deletions)];
        parts.push(plural(self.files, "file", "files"));
        if self.untracked > 0 {
            parts.push(format!("{} untracked", self.untracked));
        }
        if self.commits > 0 {
            parts.push(plural(self.commits, "commit", "commits"));
        }
        parts.join(" · ")
    }
}

/// Separates one lane's record in the stats script's output.
const RECORD: char = '\x1e';
/// Separates the sections of one record.
const SECTION: char = '\x1f';

/// A script reporting, for each checkout still on disk, its tracked changes
/// since `base` (working tree included), its untracked files, and its commits
/// since `base`. A checkout that is gone prints nothing.
pub(crate) fn stats_script<S: AsRef<str>>(checkouts: &[S], base: &str) -> String {
    let base = shell_quote(base);
    let mut script = String::new();
    for (index, checkout) in checkouts.iter().enumerate() {
        let path = shell_quote(checkout.as_ref());
        script.push_str(&format!(
            r#"if git -C {path} rev-parse --git-dir >/dev/null 2>&1; then
printf '\036%s\n' {index}
git -C {path} diff --numstat {base} -- 2>/dev/null || :
printf '\037\n'
git -C {path} ls-files --others --exclude-standard 2>/dev/null | wc -l
printf '\037\n'
git -C {path} rev-list --count {base}..HEAD 2>/dev/null || printf '0\n'
fi
"#
        ));
    }
    script
}

/// Read [`stats_script`]'s output for `lanes` checkouts. A lane without a
/// well-formed record has no stats.
pub(crate) fn parse_stats(output: &str, lanes: usize) -> Vec<Option<DiffStat>> {
    let mut stats = vec![None; lanes];
    for record in output.split(RECORD).skip(1) {
        let Some((index, rest)) = record.split_once('\n') else {
            continue;
        };
        let Some(slot) = index
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|index| stats.get_mut(index))
        else {
            continue;
        };
        let mut sections = rest.split(SECTION);
        let (Some(numstat), Some(untracked), Some(commits), None) = (
            sections.next(),
            sections.next(),
            sections.next(),
            sections.next(),
        ) else {
            continue;
        };
        let (Ok(untracked), Ok(commits)) = (
            untracked.trim().parse::<u64>(),
            commits.trim().parse::<u64>(),
        ) else {
            continue;
        };
        let lines = crate::git::parse_numstat(numstat);
        *slot = Some(DiffStat {
            files: numstat
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count() as u64,
            additions: lines.additions,
            deletions: lines.deletions,
            untracked,
            commits,
        });
    }
    stats
}

/// The commit `git rev-parse` printed, when it is one. Only tests read a
/// commit this way; lanes take theirs from Teleport's resolution.
#[cfg(test)]
pub(crate) fn parse_commit(output: &str) -> Option<String> {
    let commit = output.trim();
    (matches!(commit.len(), 40 | 64) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| commit.to_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
