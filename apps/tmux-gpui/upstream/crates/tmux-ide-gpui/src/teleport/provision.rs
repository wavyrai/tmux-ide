//! Put the repository on a destination that does not have it open.
//!
//! The destination checkout mirrors the source's place under the home
//! directory (`~/code/app` stays `~/code/app`). An existing checkout of the
//! same repository there is opened as it is; otherwise the repository is
//! cloned from its network `origin` without prompting, and when that fails
//! (no credentials on that host, private or unreachable remote) it is copied
//! from the source as a bundle of its branches and tags.

use super::{
    error::{Error, Result, Step},
    git,
    host::{Host, TRANSFER_IDLE, TRANSFER_OUTPUT},
    remote::{RemoteId, RepoIdentity, parse_remotes},
};
use herdr_client::{ScriptLimits, shell_quote};
use std::{io, sync::atomic::AtomicBool};

const TRANSFER: ScriptLimits = ScriptLimits {
    output: TRANSFER_OUTPUT,
    idle: TRANSFER_IDLE,
};

/// Where the source repository lives, and what a copy needs to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceRepository {
    /// The main checkout, relative to the source home when it is under it.
    pub(crate) relative: String,
    /// `origin`'s URL when it names a network location another host can use.
    pub(crate) origin: Option<String>,
}

pub(crate) fn source_repository(
    host: &Host,
    key: &str,
    name: &str,
    cancelled: &AtomicBool,
) -> Result<SourceRepository> {
    let body = format!(
        r#"key={key}
# A main checkout's Git directory is `<root>/.git`; resolve it physically.
case "$key" in
    */.git) root=$(cd -P -- "${{key%/.git}}" 2>/dev/null && pwd -P || :);;
    *) root=;;
esac
# Git reports physical paths, so compare against the physical home.
home=$(cd -P -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")
printf '%s\n%s\n' "$home" "$root"
git --git-dir "$key" remote get-url origin 2>/dev/null || :
"#,
        key = shell_quote(key)
    );
    let output = host.query(Step::Discover, &body, &[], cancelled)?;
    let output = String::from_utf8_lossy(&output);
    let mut lines = output.lines();
    let home = lines.next().unwrap_or_default();
    let root = lines.next().unwrap_or_default();
    let origin = lines
        .next()
        .map(str::trim)
        .filter(|url| RemoteId::parse(url).is_some())
        .map(str::to_owned);
    Ok(SourceRepository {
        relative: relative_place(home, root, name),
        origin,
    })
}

/// The checkout's path under home, or just the repository name when it lives
/// elsewhere (or its location is unknown).
fn relative_place(home: &str, root: &str, name: &str) -> String {
    let home = home.trim_end_matches('/');
    let under_home = (!home.is_empty())
        .then(|| root.strip_prefix(home))
        .flatten()
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|rest| {
            !rest.is_empty() && !rest.split('/').any(|part| matches!(part, "" | "." | ".."))
        });
    match under_home {
        Some(rest) => rest.to_owned(),
        None => sanitized_name(name),
    }
}

fn sanitized_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    match name.trim_matches('.') {
        "" => "repository".to_owned(),
        _ => name,
    }
}

/// How the repository reaches a destination that does not have it open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Arrival {
    /// A checkout of the same repository already sits at `path`.
    Existing { path: String, key: String },
    /// Nothing usable is there: clone to `path`.
    Clone { path: String },
}

/// Look at the mirrored place on `host`. A checkout of some other
/// repository, or any other file, is left alone and the clone goes beside it.
pub(crate) fn probe(
    host: &Host,
    source: &SourceRepository,
    identity: &RepoIdentity,
    cancelled: &AtomicBool,
) -> Result<Arrival> {
    let body = format!(
        r#"p="$HOME"/{relative}
printf '%s\n' "$p"
if key=$(git -C "$p" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    printf 'repo %s\n' "$key"
    git -C "$p" remote -v 2>/dev/null || :
elif [ -e "$p" ] || [ -L "$p" ]; then
    echo occupied
else
    echo free
fi
"#,
        relative = shell_quote(&source.relative)
    );
    let output = host.query(Step::Discover, &body, &[], cancelled)?;
    Ok(parse_probe(&String::from_utf8_lossy(&output), identity))
}

fn parse_probe(output: &str, identity: &RepoIdentity) -> Arrival {
    let mut lines = output.lines();
    let path = lines.next().unwrap_or_default().to_owned();
    let state = lines.next().unwrap_or_default();
    let beside = format!("{path}-teleport");
    if let Some(key) = state.strip_prefix("repo ") {
        let rest = lines.clone().collect::<Vec<_>>().join("\n");
        let candidate = RepoIdentity {
            name: identity.name.clone(),
            remotes: parse_remotes(&rest),
        };
        // The directory is named after the repository, so the name alone
        // proves nothing unless the source has no remotes to compare.
        let same = match identity.matches(&candidate) {
            Some(super::remote::MatchReason::Name) => identity.remotes.is_empty(),
            Some(_) => true,
            None => false,
        };
        if same {
            return Arrival::Existing {
                path,
                key: key.to_owned(),
            };
        }
        return Arrival::Clone { path: beside };
    }
    if state == "free" {
        Arrival::Clone { path }
    } else {
        Arrival::Clone { path: beside }
    }
}

/// Clone the repository to `path` on `destination`: from `origin` when the
/// destination can reach it without prompting, else from a bundle of the
/// source's branches and tags. Returns the new repository's Git directory.
pub(crate) fn clone(
    source: &Host,
    source_key: &str,
    destination: &Host,
    path: &str,
    origin: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<String> {
    let key = format!("{}/.git", path.trim_end_matches('/'));
    if let Some(url) = origin {
        let body = format!(
            r#"GIT_TERMINAL_PROMPT=0
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15"
export GIT_TERMINAL_PROMPT GIT_SSH_COMMAND
mkdir -p -- "$(dirname -- {path})"
git clone -q -- {url} {path} </dev/null
"#,
            url = shell_quote(url),
            path = shell_quote(path),
        );
        let cloned = destination.run(
            Step::Clone,
            &body,
            io::empty(),
            io::sink(),
            TRANSFER,
            cancelled,
        );
        match cloned {
            Ok(_) => return Ok(key),
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(error) => tracing::info!(%error, "teleport: origin clone failed; copying instead"),
        }
    }

    let bundle_body = format!(
        r#"t=$(mktemp -d "${{TMPDIR:-/tmp}}/herdr-teleport.XXXXXXXXXX")
trap 'rm -rf "$t"' EXIT
git --git-dir {key} bundle create -q "$t/bundle" HEAD --branches --tags >&2
cat "$t/bundle"
"#,
        key = shell_quote(source_key)
    );
    let mut bundle = tempfile::tempfile().map_err(Error::LocalFile)?;
    source.run(
        Step::Clone,
        &bundle_body,
        io::empty(),
        &mut bundle,
        TRANSFER,
        cancelled,
    )?;
    use std::io::Seek;
    bundle.rewind().map_err(Error::LocalFile)?;
    let uploaded = git::upload(destination, bundle, cancelled)?;
    let origin_fix = match origin {
        Some(url) => format!(
            "git -C {} remote set-url origin {}\n",
            shell_quote(path),
            shell_quote(url)
        ),
        None => format!("git -C {} remote remove origin\n", shell_quote(path)),
    };
    let body = format!(
        "mkdir -p -- \"$(dirname -- {path})\"\ngit clone -q -- {bundle} {path}\n{origin_fix}",
        path = shell_quote(path),
        bundle = shell_quote(&uploaded),
    );
    let cloned = destination.run(
        Step::Clone,
        &body,
        io::empty(),
        io::sink(),
        TRANSFER,
        cancelled,
    );
    let _ = git::discard_upload(destination, &uploaded, cancelled);
    cloned.map(|_| key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(remotes: &str) -> RepoIdentity {
        RepoIdentity {
            name: "app".into(),
            remotes: parse_remotes(remotes),
        }
    }

    #[test]
    fn places_mirror_the_source_home() {
        assert_eq!(
            relative_place("/Users/me", "/Users/me/code/app", "app"),
            "code/app"
        );
        assert_eq!(
            relative_place("/Users/me/", "/Users/me/code/app", "app"),
            "code/app"
        );
        assert_eq!(relative_place("/Users/me", "/srv/app", "app"), "app");
        assert_eq!(relative_place("/Users/me", "/Users/me", "app"), "app");
        assert_eq!(relative_place("/Users/me", "/Users/me/../x", "app"), "app");
        assert_eq!(relative_place("", "/x/app", "my app/../"), "my-app-..-");
        assert_eq!(relative_place("", "", ".."), "repository");
    }

    #[test]
    fn probes_open_only_the_same_repository() {
        let origin = "origin\tgit@github.com:me/app.git (fetch)\n";
        assert_eq!(
            parse_probe("/h/code/app\nfree\n", &identity(origin)),
            Arrival::Clone {
                path: "/h/code/app".into()
            }
        );
        assert_eq!(
            parse_probe(
                &format!("/h/code/app\nrepo /h/code/app/.git\n{origin}"),
                &identity(origin)
            ),
            Arrival::Existing {
                path: "/h/code/app".into(),
                key: "/h/code/app/.git".into()
            }
        );
        // Some other repository, or anything else, is left alone.
        let other = "origin\tgit@github.com:me/other.git (fetch)\n";
        assert_eq!(
            parse_probe(
                &format!("/h/code/app\nrepo /h/code/app/.git\n{other}"),
                &identity(origin)
            ),
            Arrival::Clone {
                path: "/h/code/app-teleport".into()
            }
        );
        assert_eq!(
            parse_probe("/h/code/app\nrepo /h/code/app/.git\n", &identity(origin)),
            Arrival::Clone {
                path: "/h/code/app-teleport".into()
            }
        );
        assert_eq!(
            parse_probe("/h/code/app\noccupied\n", &identity(origin)),
            Arrival::Clone {
                path: "/h/code/app-teleport".into()
            }
        );
        // Without remotes on either side, the name is all there is.
        assert_eq!(
            parse_probe("/h/app\nrepo /h/app/.git\n", &identity("")),
            Arrival::Existing {
                path: "/h/app".into(),
                key: "/h/app/.git".into()
            }
        );
    }
}

// Host scripts need /bin/sh; Teleport is not offered on other clients.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unwrap_used)]
mod git_tests {
    use super::*;
    use herdr_client::ConnectTarget;
    use std::{fs, path::Path, process::Command};

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn host(home: &Path) -> Host {
        let mut host = Host::new(&ConnectTarget::Local).unwrap();
        host.env = vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ];
        host
    }

    #[test]
    fn a_missing_repository_is_copied_when_origin_is_unreachable() {
        let temp = tempfile::tempdir().unwrap();
        let (source_home, destination_home) = (temp.path().join("src"), temp.path().join("dst"));
        let repo = source_home.join("code/app");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&destination_home).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("README"), "hi\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "base"]);
        git(&repo, &["branch", "feature"]);
        // A reserved, unresolvable name: the clone from origin fails fast.
        let url = "https://example.invalid/me/app.git";
        git(&repo, &["remote", "add", "origin", url]);
        let key = repo.join(".git").to_string_lossy().into_owned();
        let (source, destination) = (host(&source_home), host(&destination_home));
        let cancelled = AtomicBool::new(false);

        let origin = source_repository(&source, &key, "app", &cancelled).unwrap();
        assert_eq!(
            origin,
            SourceRepository {
                relative: "code/app".into(),
                origin: Some(url.into()),
            }
        );
        let identity = RepoIdentity {
            name: "app".into(),
            remotes: parse_remotes(&format!("origin\t{url} (fetch)\n")),
        };
        let place = destination_home
            .join("code/app")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            probe(&destination, &origin, &identity, &cancelled).unwrap(),
            Arrival::Clone {
                path: place.clone()
            }
        );

        let cloned = clone(
            &source,
            &key,
            &destination,
            &place,
            origin.origin.as_deref(),
            &cancelled,
        )
        .unwrap();
        assert_eq!(cloned, format!("{place}/.git"));
        let copy = Path::new(&place);
        assert_eq!(
            git(copy, &["rev-parse", "HEAD"]),
            git(&repo, &["rev-parse", "HEAD"])
        );
        assert_eq!(git(copy, &["remote", "get-url", "origin"]), url);
        assert!(git(copy, &["branch", "-a"]).contains("feature"));

        // Next time the checkout is found and opened rather than cloned again.
        let key_there = git(
            copy,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        assert_eq!(
            probe(&destination, &origin, &identity, &cancelled).unwrap(),
            Arrival::Existing {
                path: place.clone(),
                key: key_there,
            }
        );

        // A different repository in that place is left alone.
        git(
            copy,
            &[
                "remote",
                "set-url",
                "origin",
                "https://example.invalid/other.git",
            ],
        );
        assert_eq!(
            probe(&destination, &origin, &identity, &cancelled).unwrap(),
            Arrival::Clone {
                path: format!("{place}-teleport")
            }
        );
    }
}
