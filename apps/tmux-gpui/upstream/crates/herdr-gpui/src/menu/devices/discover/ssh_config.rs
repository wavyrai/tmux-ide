//! Concrete `Host` aliases from the user's OpenSSH configuration, following
//! `Include`. Patterns, negations, and `Match` blocks name no single machine,
//! so they are skipped; only enough is parsed to list aliases and the
//! `HostName` each one points at.

use super::{Candidate, Source, valid_host};
use crate::{Error, Result};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

/// OpenSSH allows 16 levels; a configuration that deep is not a device list.
const MAX_DEPTH: usize = 4;
const MAX_FILES: usize = 32;
const MAX_FILE: u64 = 256 * 1024;
const MAX_ALIASES: usize = 64;

/// Git hosting services are common SSH config entries but never devices.
const FORGES: [&str; 7] = [
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "git.sr.ht",
    "ssh.dev.azure.com",
    "vs-ssh.visualstudio.com",
];

/// The aliases in `~/.ssh/config`, or none when it does not exist. Blocks on
/// the file system: call it from the background executor.
pub(super) fn hosts() -> Result<Vec<Candidate>> {
    let home = crate::config::home()?;
    let mut reader = Reader::new(home, read_file);
    reader.include("~/.ssh/config", 0, &[])?;
    Ok(reader.candidates())
}

/// A file's text, `None` when it does not exist, cut at `MAX_FILE`.
fn read_file(path: &Path) -> io::Result<Option<String>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE).read_to_end(&mut bytes)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

pub(super) struct Reader<F> {
    home: PathBuf,
    load: F,
    files: usize,
    /// Each alias with the first `HostName` given for it.
    aliases: Vec<(String, Option<String>)>,
}

impl<F: FnMut(&Path) -> io::Result<Option<String>>> Reader<F> {
    pub(super) fn new(home: PathBuf, load: F) -> Self {
        Self {
            home,
            load,
            files: 0,
            aliases: Vec::new(),
        }
    }

    /// Read every file an `Include` argument names. Relative paths are under
    /// `~/.ssh`, as OpenSSH resolves them for a user configuration; `*` and
    /// `?` are expanded in the last path component only. Each file starts
    /// inside `block`, the `Host` block that included it, as in OpenSSH, so
    /// its `HostName` applies to those aliases.
    pub(super) fn include(&mut self, argument: &str, depth: usize, block: &[usize]) -> Result<()> {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        let path = match argument.strip_prefix("~/") {
            Some(rest) => self.home.join(rest),
            None => self.home.join(".ssh").join(argument),
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let paths = if name.contains(['*', '?']) {
            let pattern = name.to_owned();
            let Some(directory) = path.parent() else {
                return Ok(());
            };
            let mut paths: Vec<PathBuf> = match fs::read_dir(directory) {
                Ok(entries) => entries
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_str()
                            .is_some_and(|name| wildcard(&pattern, name))
                    })
                    .map(|entry| entry.path())
                    .collect(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
                Err(source) => {
                    return Err(Error::SshConfig {
                        path: directory.to_owned(),
                        source,
                    });
                }
            };
            paths.sort();
            paths
        } else {
            vec![path]
        };
        for path in paths {
            if self.files >= MAX_FILES {
                break;
            }
            self.files += 1;
            let text = (self.load)(&path).map_err(|source| Error::SshConfig {
                path: path.clone(),
                source,
            })?;
            if let Some(text) = text {
                self.parse(&text, depth, block)?;
            }
        }
        Ok(())
    }

    /// Parse one file that starts inside `block`. A `Host` or `Match` line in
    /// it ends that block for the rest of this file only.
    pub(super) fn parse(&mut self, text: &str, depth: usize, block: &[usize]) -> Result<()> {
        // Indices into `aliases` that the current `Host` line declared.
        let mut current: Vec<usize> = block.to_vec();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let split = line
                .find(|c: char| c.is_whitespace() || c == '=')
                .unwrap_or(line.len());
            let (keyword, rest) = line.split_at(split);
            let rest = rest.trim_start();
            let rest = rest.strip_prefix('=').unwrap_or(rest);
            let arguments = arguments(rest);
            match keyword.to_ascii_lowercase().as_str() {
                "host" => {
                    current.clear();
                    for pattern in &arguments {
                        if let Some(index) = self.alias(pattern) {
                            current.push(index);
                        }
                    }
                }
                "match" => current.clear(),
                "hostname" => {
                    let Some(hostname) = arguments.first() else {
                        continue;
                    };
                    for &index in &current {
                        self.aliases[index]
                            .1
                            .get_or_insert_with(|| hostname.clone());
                    }
                }
                "include" => {
                    for argument in &arguments {
                        self.include(argument, depth + 1, &current)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// The index of a concrete alias, added on first sight.
    fn alias(&mut self, pattern: &str) -> Option<usize> {
        if pattern.contains(['*', '?', '!']) || !valid_host(pattern) || forge(pattern) {
            return None;
        }
        if let Some(index) = self.aliases.iter().position(|(alias, _)| alias == pattern) {
            return Some(index);
        }
        if self.aliases.len() >= MAX_ALIASES {
            return None;
        }
        self.aliases.push((pattern.to_owned(), None));
        Some(self.aliases.len() - 1)
    }

    pub(super) fn candidates(self) -> Vec<Candidate> {
        self.aliases
            .into_iter()
            .filter(|(_, hostname)| !hostname.as_deref().is_some_and(forge))
            .map(|(alias, hostname)| {
                // `%h` and other tokens are expanded by ssh, not here. Without
                // a `HostName`, ssh connects to the alias itself.
                let hostname = hostname.filter(|hostname| !hostname.contains('%'));
                let host = hostname.as_deref().unwrap_or(&alias);
                Candidate::new(Source::SshConfig, &alias, alias.clone(), &[host]).with_alias(&alias)
            })
            .collect()
    }
}

fn forge(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    FORGES.iter().any(|forge| {
        host == *forge
            || host
                .strip_suffix(forge)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

/// Whitespace-separated arguments, where double quotes group words.
fn arguments(text: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    arguments.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        arguments.push(current);
    }
    arguments
}

/// Glob matching with `*` (any run) and `?` (one character).
pub(super) fn wildcard(pattern: &str, name: &str) -> bool {
    let (pattern, name): (Vec<char>, Vec<char>) =
        (pattern.chars().collect(), name.chars().collect());
    let (mut p, mut n) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, n));
            p += 1;
        } else if let Some((star_p, star_n)) = star {
            p = star_p + 1;
            n = star_n + 1;
            star = Some((star_p, star_n + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}
