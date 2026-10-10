//! Fetching a PR: the GraphQL query, the Git commands that identify the
//! checkout, and the bounded subprocess policy they all run under. Output is
//! size-capped and every call has a deadline, so no step can hang the worker.

use super::{Input, Origin, Result, parse_graphql, parse_numbered};
use crate::Error;
#[cfg(unix)]
use std::os::{fd::OwnedFd, unix::net::UnixStream};
use std::{
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(super) const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
pub(super) const TIMEOUT: Duration = Duration::from_secs(15);
/// Every field a lookup reads, shared by both queries as a GraphQL fragment.
macro_rules! fields {
    () => {
        r#"
fragment PullRequestFields on PullRequest {
  id number url title state isDraft headRefName headRefOid baseRefName additions deletions
  changedFiles updatedAt mergeStateStatus reviewDecision isCrossRepository
  headRepositoryOwner { login } headRepository { name }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    contexts(first: 100) {
      pageInfo { hasNextPage }
      nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }
    }
  } } } }
}"#
    };
}
const QUERY: &str = concat!(
    r#"query($owner: String!, $repo: String!, $branch: String!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequests(first: $limit, headRefName: $branch, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes { ...PullRequestFields }
    }
  }
}"#,
    fields!()
);
/// A fork's pull request, by the number its local `pr/<number>` branch names.
const NUMBER_QUERY: &str = concat!(
    r#"query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) { ...PullRequestFields }
  }
}"#,
    fields!()
);

/// How long a remote repository's origin is trusted before SSH reads it again.
const ORIGIN_TTL: Duration = Duration::from_secs(10 * 60);
const ORIGIN_LIMIT: usize = 64;

/// GitHub repositories resolved on saved hosts, keyed by SSH target and Git
/// directory. Bounded, and owned by the single PR worker thread.
#[derive(Default)]
pub(super) struct Origins(Vec<(String, String, Instant, (String, String))>);

impl Origins {
    fn resolve(
        &mut self,
        target: &str,
        input: &Input,
        now: Instant,
        deadline: Instant,
        cancelled: &impl Fn() -> bool,
    ) -> crate::Result<(String, String)> {
        // A remote workspace without daemon metadata never gets this far.
        let key = input.repo_key.as_deref().ok_or(Error::PrMetadata)?;
        self.0
            .retain(|(_, _, resolved, _)| now.duration_since(*resolved) < ORIGIN_TTL);
        if let Some((.., repository)) = self
            .0
            .iter()
            .find(|(host, known, ..)| host == target && known == key)
        {
            return Ok(repository.clone());
        }
        let timeout = deadline
            .checked_duration_since(now)
            .ok_or(Error::PrTimeout)?;
        // The daemon's branch is trusted as reported: this client cannot run
        // local Git against the host's checkout to re-verify it.
        let remote = herdr_client::remote_origin_url(target, key, timeout, cancelled)?
            .ok_or(Error::PrOrigin)?;
        let repository = crate::avatars::github_repo(&remote).ok_or(Error::PrOrigin)?;
        if self.0.len() == ORIGIN_LIMIT {
            self.0.remove(0);
        }
        self.0
            .push((target.to_owned(), key.to_owned(), now, repository.clone()));
        Ok(repository)
    }
}

#[cfg(test)]
pub(super) fn fetch(
    input: &Input,
    token: &secrecy::SecretString,
    cancelled: impl Fn() -> bool,
) -> Result {
    fetch_with_backoff(
        input,
        &Origin::Local,
        &mut Origins::default(),
        token,
        cancelled,
        &mut None,
    )
}

pub(super) fn fetch_with_backoff(
    input: &Input,
    origin: &Origin,
    origins: &mut Origins,
    token: &secrecy::SecretString,
    cancelled: impl Fn() -> bool,
    cooldown: &mut Option<Duration>,
) -> Result {
    let deadline = Instant::now() + TIMEOUT;
    let ((owner, repo), head) = match origin {
        Origin::Local => {
            let checkout = local_checkout(input, deadline, &cancelled)?;
            let repository = origin_repository(&checkout, deadline, &cancelled)?;
            let head = upstream_head(&input.branch, |key| {
                let value = git(
                    &checkout,
                    &["config", "--default", "", "--get", key],
                    deadline,
                    &cancelled,
                )?;
                Ok((!value.is_empty()).then_some(value))
            })?;
            (repository, head)
        }
        Origin::Ssh(target) => {
            let repository =
                origins.resolve(target, input, Instant::now(), deadline, &cancelled)?;
            let key = input.repo_key.as_deref().ok_or(Error::PrMetadata)?;
            let head = upstream_head(&input.branch, |name| {
                let timeout = deadline
                    .checked_duration_since(Instant::now())
                    .ok_or(Error::PrTimeout)?;
                Ok(herdr_client::remote_config_value(
                    target, key, name, timeout, &cancelled,
                )?)
            })?;
            (repository, head)
        }
    };
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .ok_or(Error::PrTimeout)?;
    // A fork checkout has no upstream and a local name its PR never uses, so
    // it is found by number instead (see `repo_items::fork_branch`).
    if head.is_none()
        && let Some(number) = crate::repo_items::fork_branch_number(&input.branch)
    {
        let response = crate::github::graphql(
            "pull_request",
            token,
            NUMBER_QUERY,
            serde_json::json!({"owner":owner,"repo":repo,"number":number}),
            timeout,
            cancelled,
            cooldown,
        )?;
        return parse_numbered(response, &owner, &repo, number);
    }
    let branch = head
        .as_ref()
        .map_or(input.branch.as_str(), |head| head.branch.as_str());
    let response = crate::github::graphql(
        "pull_request",
        token,
        QUERY,
        serde_json::json!({"owner":owner,"repo":repo,"branch":branch,"limit":if head.is_some() { 100 } else { 2 }}),
        timeout,
        cancelled,
        cooldown,
    )?;
    parse_graphql(response, &owner, &repo, branch, head.as_ref())
}

/// The remote head configured for this local branch, independent of its local name.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Head {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}

pub(super) fn upstream_head(
    branch: &str,
    mut config: impl FnMut(&str) -> crate::Result<Option<String>>,
) -> crate::Result<Option<Head>> {
    let remote = config(&format!("branch.{branch}.remote"))?;
    let merge = config(&format!("branch.{branch}.merge"))?;
    let (Some(remote), Some(merge)) = (remote, merge) else {
        return Ok(None);
    };
    // An explicitly configured but unsupported upstream must not fall back to
    // a potentially unrelated origin branch (including local `.` upstreams).
    let branch = merge
        .strip_prefix("refs/heads/")
        .filter(|branch| !branch.is_empty())
        .ok_or(Error::PrBranch)?;
    let url = config(&format!("remote.{remote}.url"))?.ok_or(Error::PrOrigin)?;
    let (owner, repo) = crate::avatars::github_repo(&url).ok_or(Error::PrOrigin)?;
    Ok(Some(Head {
        owner,
        repo,
        branch: branch.to_owned(),
    }))
}

pub(crate) fn local_repository(
    input: &Input,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<(String, String)> {
    let checkout = local_checkout(input, deadline, cancelled)?;
    origin_repository(&checkout, deadline, cancelled)
}

/// The GitHub owner and repository behind a verified checkout's origin remote.
pub(crate) fn origin_repository(
    checkout: &str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<(String, String)> {
    let remote = git(
        checkout,
        &["config", "--get", "remote.origin.url"],
        deadline,
        cancelled,
    )?;
    crate::avatars::github_repo(&remote).ok_or_else(|| {
        // An SSH host alias for a second account (`github-work:owner/repo`)
        // is the usual reason; only the host is logged, never credentials.
        tracing::debug!(
            category = "github_origin",
            host = remote_host(&remote),
            "Origin remote is not a GitHub.com repository"
        );
        Error::PrOrigin
    })
}

/// The host of a Git remote, without the user, credentials, or path.
pub(super) fn remote_host(remote: &str) -> &str {
    let authority = match remote.split_once("://") {
        Some((_, rest)) => rest.split('/').next().unwrap_or_default(),
        None => remote.split(':').next().unwrap_or_default(),
    };
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
}

/// The Git common directory a lookup reads: the daemon's key, or, for a local
/// workspace the daemon has no worktree metadata for, the repository Git finds
/// at the workspace directory.
pub(crate) fn repository_key(
    input: &Input,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<String> {
    let directory = match (&input.repo_key, &input.checkout) {
        (Some(key), _) => return Ok(key.clone()),
        (None, Some(directory)) => directory,
        (None, None) => return Err(Error::PrMetadata),
    };
    if !Path::new(directory).is_absolute() {
        return Err(Error::PrAbsolutePath);
    }
    git(
        directory,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        deadline,
        cancelled,
    )
    .map_err(|error| match error {
        Error::PrCheckout => Error::PrWorkspaceRepository,
        error => error,
    })
}

/// Resolve the checkout a daemon workspace names and verify it still is that
/// repository on that branch. Every local Git operation starts here, so a
/// renamed branch or a moved worktree cannot be worked on by mistake.
pub(crate) fn local_checkout(
    input: &Input,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<String> {
    if input
        .checkout
        .as_ref()
        .is_some_and(|path| !Path::new(path).is_absolute())
        || input
            .repo_key
            .as_ref()
            .is_some_and(|key| !Path::new(key).is_absolute())
    {
        return Err(Error::PrAbsolutePath);
    }
    if input.branch.is_empty()
        || input.branch.len() > 1024
        || input.branch.chars().any(char::is_control)
    {
        return Err(Error::PrBranch);
    }
    let repo_key = repository_key(input, deadline, cancelled)?;
    let checkout = match (&input.checkout, &input.repo_key) {
        (Some(path), Some(_)) => path.clone(),
        // No daemon metadata: the workspace directory may be any folder in the
        // checkout, so work from its top level. This is the only case a
        // workspace's own directory is trusted, and it is verified below.
        (Some(directory), None) => git(
            directory,
            &["rev-parse", "--show-toplevel"],
            deadline,
            cancelled,
        )?,
        (None, _) => {
            // The daemon gives endpoint clients no checkout path. With its
            // metadata, use Git's own worktree registry, never pane cwd or the
            // new-workspace directory; that directory is read only when the
            // daemon has no metadata at all, and is verified like this one.
            let mut command = Command::new("git");
            command.args([
                "-c",
                "core.fsmonitor=false",
                "--git-dir",
                &repo_key,
                "worktree",
                "list",
                "--porcelain",
                "-z",
            ]);
            let (ok, output) = run(&mut command, deadline, cancelled)?;
            if !ok {
                return Err(Error::PrWorktreeLookup);
            }
            worktree_checkout(&output, &input.branch)?
        }
    };
    // Any candidate, registry or workspace directory, must still match both
    // the repository and the branch's live HEAD.
    let common = git(
        &checkout,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        deadline,
        cancelled,
    )?;
    if Path::new(&common)
        .canonicalize()
        .ok()
        .zip(Path::new(&repo_key).canonicalize().ok())
        .is_none_or(|(actual, expected)| actual != expected)
    {
        return Err(Error::PrRepositoryMismatch);
    }
    if git(
        &checkout,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        deadline,
        cancelled,
    )? != input.branch
    {
        return Err(Error::PrBranchChanged);
    }
    Ok(checkout)
}

/// Read-only Git output from a checkout, with the shared process policy.
fn git(
    checkout: &str,
    args: &[&str],
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<String> {
    let mut command = Command::new("git");
    command
        .args(["-c", "core.fsmonitor=false", "-C", checkout])
        .args(args);
    run(&mut command, deadline, cancelled).and_then(|(ok, output)| {
        if ok {
            Ok(output.trim_end_matches(['\r', '\n']).to_owned())
        } else {
            Err(Error::PrCheckout)
        }
    })
}

pub(super) fn worktree_checkout(output: &str, branch: &str) -> crate::Result<String> {
    let branch = format!("branch refs/heads/{branch}");
    let mut paths = output.split("\0\0").filter_map(|record| {
        let mut fields = record.split('\0');
        let path = fields.next()?.strip_prefix("worktree ")?;
        (Path::new(path).is_absolute() && fields.any(|field| field == branch)).then_some(path)
    });
    let path = paths.next().ok_or(Error::PrMissingWorktree)?;
    if paths.next().is_some() {
        return Err(Error::PrAmbiguousWorktree);
    }
    Ok(path.into())
}

pub(crate) fn run(
    command: &mut Command,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<(bool, String)> {
    let (ok, output) = run_bytes(command, deadline, cancelled, OUTPUT_LIMIT)?;
    String::from_utf8(output)
        .map(|text| (ok, text))
        .map_err(|error| Error::PrEncoding(error.utf8_error()))
}

/// [`run`], keeping up to `limit` bytes of output as they came: for output
/// that may be large, or may not be text.
pub(crate) fn run_bytes(
    command: &mut Command,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
    limit: usize,
) -> crate::Result<(bool, Vec<u8>)> {
    if cancelled() {
        return Err(Error::PrCancelled);
    }
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir("/")
        .env_remove("GH_REPO")
        .env_remove("GH_DEBUG")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    let (output, mut child) = capture(command)?;
    // Command retains Stdio descriptors after spawn; release them so EOF is observable.
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let result = collect(output, &mut child, deadline, cancelled, limit);
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

fn spawned(source: std::io::Error) -> Error {
    Error::PrProcess {
        operation: "launch Git (install git on PATH)",
        source,
    }
}

fn unreadable(source: std::io::Error) -> Error {
    Error::PrProcess {
        operation: "read process output",
        source,
    }
}

/// Merges the child's stdout and stderr into one stream this process can poll.
#[cfg(unix)]
fn capture(command: &mut Command) -> crate::Result<(UnixStream, Child)> {
    let (reader, writer) = UnixStream::pair().map_err(|source| Error::PrProcess {
        operation: "create process output channel",
        source,
    })?;
    reader
        .set_nonblocking(true)
        .map_err(|source| Error::PrProcess {
            operation: "configure process output",
            source,
        })?;
    let error_writer = writer.try_clone().map_err(|source| Error::PrProcess {
        operation: "configure process errors",
        source,
    })?;
    command
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::from(OwnedFd::from(error_writer)));
    let child = command.spawn().map_err(spawned)?;
    Ok((reader, child))
}

/// Windows cannot hand a socket to a child as its standard streams, so the two
/// halves of the output join in an anonymous pipe instead.
#[cfg(windows)]
fn capture(command: &mut Command) -> crate::Result<(std::io::PipeReader, Child)> {
    let (reader, writer) = std::io::pipe().map_err(|source| Error::PrProcess {
        operation: "create process output channel",
        source,
    })?;
    let error_writer = writer.try_clone().map_err(|source| Error::PrProcess {
        operation: "configure process errors",
        source,
    })?;
    command
        .stdout(Stdio::from(writer))
        .stderr(Stdio::from(error_writer));
    let child = command.spawn().map_err(spawned)?;
    Ok((reader, child))
}

/// Reads the merged output under the caller's deadline and cancellation. The
/// child is only reaped once its output has ended, so nothing is truncated.
#[cfg(unix)]
fn collect(
    mut reader: UnixStream,
    child: &mut Child,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
    limit: usize,
) -> crate::Result<(bool, Vec<u8>)> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    let mut eof = false;
    loop {
        if cancelled() {
            return Err(Error::PrCancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::PrTimeout);
        }
        match reader.read(&mut buffer) {
            Ok(0) => eof = true,
            Ok(n) => {
                if output.len() + n > limit {
                    return Err(Error::PrSize);
                }
                output.extend_from_slice(&buffer[..n]);
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(source) => return Err(unreadable(source)),
        }
        if let Some(status) = child.try_wait().map_err(|source| Error::PrProcess {
            operation: "wait for process",
            source,
        })? && eof
        {
            return Ok((status.success(), output));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// An anonymous pipe on Windows cannot be made nonblocking, so the reads run on
/// their own thread and the deadline is enforced here. Killing the child closes
/// the last writer, which ends that thread.
#[cfg(windows)]
fn collect(
    mut reader: std::io::PipeReader,
    child: &mut Child,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
    limit: usize,
) -> crate::Result<(bool, Vec<u8>)> {
    let (sender, reads) = std::sync::mpsc::channel();
    thread::Builder::new()
        .name("herdr-pr-output".into())
        .spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0; 8192];
            let result = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break Ok(output),
                    Ok(n) => {
                        if output.len() + n > limit {
                            break Err(Error::PrSize);
                        }
                        output.extend_from_slice(&buffer[..n]);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(source) => break Err(unreadable(source)),
                }
            };
            let _ = sender.send(result);
        })
        .map_err(unreadable)?;
    let mut ended: Option<Vec<u8>> = None;
    loop {
        if cancelled() {
            return Err(Error::PrCancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::PrTimeout);
        }
        if ended.is_none() {
            match reads.try_recv() {
                Ok(result) => ended = Some(result?),
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err(unreadable(std::io::Error::other("output reader stopped")));
                }
            }
        }
        if let Some(status) = child.try_wait().map_err(|source| Error::PrProcess {
            operation: "wait for process",
            source,
        })? && let Some(output) = ended.take()
        {
            return Ok((status.success(), output));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod origin_tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn input(key: &str) -> Input {
        Input {
            checkout: None,
            repo_key: Some(key.into()),
            branch: "main".into(),
        }
    }

    #[test]
    fn remote_origins_are_reused_until_they_expire() {
        // Time only moves forward here: an `Instant` cannot go before boot.
        let now = Instant::now();
        let deadline = now + TIMEOUT;
        // An invalid target fails before SSH, so reaching it proves a miss.
        let target = "-not-dialled";
        let mut origins = Origins(vec![(
            target.into(),
            "/repo/.git".into(),
            now,
            ("owner".into(), "repo".into()),
        )]);
        let mut resolve = |key: &str, at: Instant| {
            origins.resolve(target, &input(key), at, deadline.max(at + TIMEOUT), &|| {
                false
            })
        };
        assert_eq!(
            resolve("/repo/.git", now).unwrap(),
            ("owner".into(), "repo".into())
        );
        // Another repository on the same host is not a hit.
        assert!(matches!(
            resolve("/other/.git", now),
            Err(Error::Client(herdr_client::Error::InvalidSshTarget))
        ));
        assert!(resolve("/repo/.git", now + ORIGIN_TTL).is_err());
        assert!(origins.0.is_empty());
    }
}
