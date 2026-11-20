//! The Machines step's suggestions: the literal `Host` names in the user's
//! SSH config (owner decision D, 18 Nov 2026). Read-only text parsing off the
//! UI thread; nothing is run (a ProxyCommand stays text) and nothing
//! connects until a suggestion is clicked. Patterns, negations, `Match`
//! blocks and names the add-machine field would refuse are left out.
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
};

/// At most this many suggestions.
pub(super) const MAX: usize = 8;
/// A config file larger than this is skipped whole.
pub(super) const LIMIT: u64 = 256 * 1024;
/// Include depth (ssh allows 16) and files read in all.
const DEPTH: usize = 8;
const FILES: usize = 64;

/// `~/.ssh` for `home`.
pub(super) fn ssh_dir(home: &Path) -> PathBuf {
    home.join(".ssh")
}

/// The literal Host names in `ssh_dir/config` and what it includes, in
/// order, once each, at most [`MAX`]. `home` resolves `~/` in an Include.
pub(super) fn hosts(ssh_dir: &Path, home: &Path) -> Vec<String> {
    let mut reader = Reader {
        ssh_dir,
        home,
        seen: HashSet::new(),
        files: 0,
        hosts: Vec::new(),
    };
    reader.file(&ssh_dir.join("config"), 0);
    reader.hosts
}

struct Reader<'a> {
    ssh_dir: &'a Path,
    home: &'a Path,
    seen: HashSet<PathBuf>,
    files: usize,
    hosts: Vec<String>,
}
impl Reader<'_> {
    fn file(&mut self, path: &Path, depth: usize) {
        if depth > DEPTH || self.files >= FILES || self.hosts.len() >= MAX {
            return;
        }
        let Ok(real) = std::fs::canonicalize(path) else {
            return;
        };
        if !real.is_file() || !self.seen.insert(real.clone()) {
            return;
        }
        self.files += 1;
        let mut bytes = Vec::new();
        let read =
            std::fs::File::open(&real).and_then(|f| f.take(LIMIT + 1).read_to_end(&mut bytes));
        if read.is_err() || bytes.len() as u64 > LIMIT {
            return;
        }
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            let Some((keyword, args)) = directive(line) else {
                continue;
            };
            if keyword.eq_ignore_ascii_case("host") {
                for name in args {
                    if self.hosts.len() < MAX && literal(&name) && !self.hosts.contains(&name) {
                        self.hosts.push(name);
                    }
                }
            } else if keyword.eq_ignore_ascii_case("include") {
                for pattern in args {
                    for included in self.expand(&pattern) {
                        self.file(&included, depth + 1);
                    }
                }
            }
        }
    }
    /// An Include argument's files: `~/` is home, a relative path is under
    /// ~/.ssh, and `*` or `?` in the file name match within its directory.
    fn expand(&self, pattern: &str) -> Vec<PathBuf> {
        let path = match pattern.strip_prefix("~/") {
            Some(rest) => self.home.join(rest),
            None if Path::new(pattern).is_absolute() => PathBuf::from(pattern),
            None => self.ssh_dir.join(pattern),
        };
        let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
        else {
            return Vec::new();
        };
        if !name.contains(['*', '?']) {
            return vec![path];
        }
        let Ok(entries) = std::fs::read_dir(parent) else {
            return Vec::new();
        };
        let mut matched: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_str().is_some_and(|n| glob(name, n)))
            .map(|e| e.path())
            .take(FILES)
            .collect();
        matched.sort();
        matched
    }
}

/// A config line's keyword and arguments (`Keyword args`, `Keyword=args`),
/// with double quotes grouping and a `#` starting a comment.
fn directive(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim_start();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let keyword = line[..end].to_string();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    let mut args = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            '#' if !quoted && word.is_empty() => break,
            c if c.is_whitespace() && !quoted => {
                if !word.is_empty() {
                    args.push(std::mem::take(&mut word));
                }
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        args.push(word);
    }
    Some((keyword, args))
}

/// A literal host alias the add-machine field takes as it is: no pattern
/// (`*`, `?`), negation, token or user, and no leading `-`.
fn literal(name: &str) -> bool {
    name.len() <= 255
        && name
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

/// `*` and `?` matching, for an Include's file name (row by row, so a
/// pattern with many stars stays linear in the name).
fn glob(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.as_bytes(), name.as_bytes());
    if name.starts_with('.') {
        return false;
    }
    // can[j]: the pattern so far matches the first j bytes of the name.
    let mut can = vec![false; n.len() + 1];
    can[0] = true;
    for c in p {
        let mut next = vec![false; n.len() + 1];
        for j in 0..=n.len() {
            next[j] = match c {
                b'*' => can[j] || (j > 0 && next[j - 1]),
                b'?' => j > 0 && can[j - 1],
                c => j > 0 && can[j - 1] && n[j - 1] == *c,
            };
        }
        can = next;
    }
    can[n.len()]
}

#[cfg(test)]
#[path = "ssh_hosts_tests.rs"]
mod tests;
