//! Identify "the same repository" on another host.
//!
//! `ClientShellWorktree.key` is a host-local path, so repositories are matched
//! by their Git remotes, falling back to the repository name.

/// A remote URL reduced to `host/path`, lowercase host, no scheme, user,
/// port, or `.git` suffix. `git@github.com:o/r.git`, `https://github.com/o/r`,
/// and `ssh://git@github.com:22/o/r` all normalize to `github.com/o/r`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct RemoteId(String);

impl RemoteId {
    /// Parse a remote URL. Local paths and `file://` remotes name a location
    /// on one machine and never identify a repository across hosts.
    pub(crate) fn parse(url: &str) -> Option<Self> {
        let url = url.trim();
        let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
            if !matches!(
                scheme.to_ascii_lowercase().as_str(),
                "ssh" | "git+ssh" | "ssh+git" | "git" | "http" | "https"
            ) {
                return None;
            }
            let (authority, path) = rest.split_once('/')?;
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            let host = host.split_once(':').map_or(host, |(h, _)| h);
            (host, path)
        } else {
            // scp-like `[user@]host:path`; a slash before the colon is a path.
            let (authority, path) = url.split_once(':')?;
            // A one-letter authority is a Windows drive, as Git treats it.
            if authority.contains('/') || authority.len() < 2 {
                return None;
            }
            (
                authority.rsplit_once('@').map_or(authority, |(_, h)| h),
                path,
            )
        };
        let path = path.trim_matches('/');
        let path = path
            .strip_suffix(".git")
            .unwrap_or(path)
            .trim_end_matches('/');
        if host.is_empty() || path.is_empty() {
            return None;
        }
        Some(Self(format!("{}/{path}", host.to_ascii_lowercase())))
    }

    /// The lowercase host the repository lives on.
    pub(crate) fn host(&self) -> &str {
        self.0
            .split_once('/')
            .map_or(self.0.as_str(), |(host, _)| host)
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// Parse `git remote -v` output into remote names and identities, keeping
/// fetch URLs only and each remote once.
pub(crate) fn parse_remotes(output: &str) -> Vec<(String, RemoteId)> {
    let mut remotes: Vec<(String, RemoteId)> = Vec::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(url), Some("(fetch)")) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Some(id) = RemoteId::parse(url) else {
            continue;
        };
        if !remotes.iter().any(|(existing, _)| existing == name) {
            remotes.push((name.to_owned(), id));
        }
    }
    remotes
}

/// Why a destination repository was offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum MatchReason {
    /// Shares the source's `origin` remote.
    Origin,
    /// Shares some other remote.
    Remote,
    /// Only the repository name matches; confirm before applying.
    Name,
}

/// What is known about one repository on one host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RepoIdentity {
    pub(crate) name: String,
    pub(crate) remotes: Vec<(String, RemoteId)>,
}

impl RepoIdentity {
    /// How `candidate` relates to `self`, strongest reason first.
    pub(crate) fn matches(&self, candidate: &RepoIdentity) -> Option<MatchReason> {
        let origin = |remotes: &[(String, RemoteId)]| {
            remotes
                .iter()
                .find(|(name, _)| name == "origin")
                .map(|(_, id)| id.clone())
        };
        if let (Some(ours), Some(theirs)) = (origin(&self.remotes), origin(&candidate.remotes))
            && ours == theirs
        {
            return Some(MatchReason::Origin);
        }
        if self
            .remotes
            .iter()
            .any(|(_, ours)| candidate.remotes.iter().any(|(_, theirs)| ours == theirs))
        {
            return Some(MatchReason::Remote);
        }
        (!self.name.is_empty() && self.name == candidate.name).then_some(MatchReason::Name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(url: &str) -> Option<String> {
        RemoteId::parse(url).map(|id| id.as_str().to_owned())
    }

    #[test]
    fn equivalent_spellings_normalize_to_one_identity() {
        for url in [
            "git@github.com:penso/herdr-gpui.git",
            "git@GitHub.com:penso/herdr-gpui",
            "https://github.com/penso/herdr-gpui",
            "https://token@github.com/penso/herdr-gpui.git/",
            "ssh://git@github.com:22/penso/herdr-gpui.git",
            "git+ssh://github.com/penso/herdr-gpui",
            "github.com:penso/herdr-gpui.git",
        ] {
            assert_eq!(
                id(url).as_deref(),
                Some("github.com/penso/herdr-gpui"),
                "{url}"
            );
        }
    }

    #[test]
    fn host_local_remotes_never_match_across_hosts() {
        for url in [
            "/srv/git/repo.git",
            "./relative",
            "../sibling/repo",
            "file:///srv/git/repo.git",
            "C:/repos/x",
            "",
            "https://github.com/",
        ] {
            assert_eq!(id(url), None, "{url:?}");
        }
    }

    #[test]
    fn parse_remotes_keeps_fetch_urls_once() {
        let output = "origin\tgit@github.com:o/r.git (fetch)\n\
                      origin\tgit@github.com:o/r.git (push)\n\
                      upstream\thttps://github.com/u/r (fetch)\n\
                      local\t/tmp/x (fetch)\n\
                      garbage\n";
        let remotes = parse_remotes(output);
        let names: Vec<_> = remotes
            .iter()
            .map(|(n, id)| (n.as_str(), id.as_str()))
            .collect();
        assert_eq!(
            names,
            [("origin", "github.com/o/r"), ("upstream", "github.com/u/r")]
        );
    }

    #[test]
    fn match_prefers_origin_then_any_remote_then_name() {
        let repo = |name: &str, remotes: &[(&str, &str)]| RepoIdentity {
            name: name.into(),
            remotes: remotes
                .iter()
                .filter_map(|(n, url)| Some(((*n).to_owned(), RemoteId::parse(url)?)))
                .collect(),
        };
        let source = repo(
            "herdr",
            &[
                ("origin", "git@github.com:me/herdr"),
                ("up", "https://github.com/og/herdr"),
            ],
        );
        assert_eq!(
            source.matches(&repo(
                "renamed",
                &[("origin", "https://github.com/me/herdr.git")]
            )),
            Some(MatchReason::Origin)
        );
        assert_eq!(
            source.matches(&repo("x", &[("origin", "https://github.com/og/herdr")])),
            Some(MatchReason::Remote)
        );
        assert_eq!(source.matches(&repo("herdr", &[])), Some(MatchReason::Name));
        assert_eq!(
            source.matches(&repo("other", &[("origin", "git@gitlab.com:me/herdr")])),
            None
        );
        assert_eq!(repo("", &[]).matches(&repo("", &[])), None);
        assert!(
            MatchReason::Origin < MatchReason::Remote && MatchReason::Remote < MatchReason::Name
        );
    }
}
