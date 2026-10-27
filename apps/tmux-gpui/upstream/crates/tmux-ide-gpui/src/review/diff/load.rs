//! Reading a checkout's changes: the files first, then their lines a batch
//! at a time. Everything here runs Git or reads files, so it belongs on a
//! background thread.
use super::{
    Body, Diff, FileDiff, Lines, Scope, Status,
    budget::{self, ASKED_OUTPUT, AUTO_FILE_BYTES, BATCH_OUTPUT, MAX_UNTRACKED},
    lockfile,
    parse::parse,
};
use crate::pull_request::Input;
use std::{
    collections::{HashMap, HashSet},
    io::Read as _,
    path::{Component, Path},
    sync::Arc,
    time::{Duration, Instant},
};

const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Output of the listing calls, which hold a few fields per file.
const LIST_OUTPUT: usize = 16 * 1024 * 1024;
/// Bytes Git reads of a file to call it binary; the same here.
const SNIFF: usize = 8000;
/// Paths asked about generated code per call, and in all.
const ATTRIBUTE_CHUNK: usize = 500;
const ATTRIBUTE_FILES: usize = 10_000;

/// Where a review's lines come from: the checkout, what it is compared
/// with, and how.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub checkout: String,
    revision: String,
    /// Changes in whitespace alone are left out.
    whitespace: bool,
}

impl Source {
    #[cfg(test)]
    pub(crate) fn local(checkout: &str) -> Self {
        Self {
            checkout: checkout.into(),
            revision: "HEAD".into(),
            whitespace: false,
        }
    }
}

/// The changes in a checkout, listed, with the lines read so far.
#[derive(Debug)]
pub(crate) struct Loaded {
    pub source: Source,
    pub scope: Scope,
    /// The ref the branch is compared with, for `Scope::Branch`.
    pub base: Option<String>,
    pub diff: Diff,
}

impl Loaded {
    /// Reads every listed file's lines the view would read unasked, as its
    /// batches do. Blocking.
    #[cfg(test)]
    pub(crate) fn read_all(&mut self) {
        let requests: Vec<Request> = self
            .diff
            .files
            .iter()
            .enumerate()
            .filter(|(_, file)| file.body == Body::Pending)
            .map(|(index, file)| Request::of(index, file))
            .collect();
        for (file, body) in bodies(&self.source, &requests, false) {
            self.diff.files[file].set_body(body);
        }
    }

    /// A listing of `diff` in a checkout at `checkout`, as if Git made it.
    #[cfg(test)]
    pub(crate) fn of(diff: Diff) -> Self {
        Self {
            source: Source::local("/work/repo"),
            scope: Scope::Uncommitted,
            base: None,
            diff,
        }
    }
}

/// A file whose lines to read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub file: usize,
    /// The names as Git wrote them, for Git, the file system, and matching
    /// the diff's own names.
    pub(super) git_path: String,
    git_old_path: Option<String>,
    untracked: bool,
}

impl Request {
    pub(crate) fn of(index: usize, file: &FileDiff) -> Self {
        Self {
            file: index,
            git_path: file.git_path.clone(),
            git_old_path: file.git_old_path.clone(),
            untracked: file.status == Status::Untracked,
        }
    }
}

/// A branch name a ref can be built from: nothing Git would read as an
/// option, a range, or a pattern. Pull request data is remote text.
pub(super) fn plain_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with(['-', '/', '.'])
        && !name.contains("..")
        && !name
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\@{".contains(c))
}

/// Refs the base may be, most specific first: the pull request's base, the
/// remote's default branch, then the usual names. Full ref names, so none can
/// be taken for an option.
pub(super) fn base_candidates(hint: Option<&str>, remote_head: Option<&str>) -> Vec<String> {
    let mut names: Vec<&str> = hint.into_iter().filter(|name| plain_branch(name)).collect();
    if let Some(head) = remote_head
        .and_then(|head| head.strip_prefix("refs/remotes/origin/"))
        .filter(|name| plain_branch(name))
    {
        names.push(head);
    }
    names.extend(["main", "master"]);
    let mut refs = Vec::new();
    for name in names {
        for candidate in [
            format!("refs/remotes/origin/{name}"),
            format!("refs/heads/{name}"),
        ] {
            if !refs.contains(&candidate) {
                refs.push(candidate);
            }
        }
    }
    refs
}

/// The first candidate that exists, shortened for display, and where HEAD
/// left it. Reads local refs only; nothing is fetched.
fn branch_base(
    checkout: &str,
    hint: Option<&str>,
    deadline: Instant,
) -> crate::Result<(String, String)> {
    let never = || false;
    let remote_head = crate::git::git(
        checkout,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        "read the remote's default branch",
        deadline,
        &never,
    )
    .ok();
    for candidate in base_candidates(hint, remote_head.as_deref()) {
        let merge_base = crate::git::git(
            checkout,
            &["merge-base", "HEAD", &candidate],
            "find where the branch started",
            deadline,
            &never,
        );
        if let Ok(commit) = merge_base {
            let label = candidate
                .strip_prefix("refs/remotes/")
                .or_else(|| candidate.strip_prefix("refs/heads/"))
                .unwrap_or(&candidate)
                .to_owned();
            return Ok((label, commit));
        }
    }
    Err(crate::Error::ReviewNoBase)
}

/// Whether `name`, as Git printed it, stays inside the checkout.
pub(crate) fn inside(name: &str) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

/// The size of a regular file in the checkout; none for a link, which is
/// never followed out of it.
fn size(root: &Path, name: &str) -> Option<u64> {
    inside(name)
        .then(|| std::fs::symlink_metadata(root.join(name)).ok())
        .flatten()
        .filter(std::fs::Metadata::is_file)
        .map(|metadata| metadata.len())
}

/// Git's output outgrew what is read: say so in the review's terms.
fn too_large(error: crate::Error) -> crate::Error {
    match error {
        crate::Error::PrSize => crate::Error::ReviewTooLarge,
        error => error,
    }
}

/// A listing call's output, as text whatever its bytes.
fn list(checkout: &str, args: &[&str], operation: &'static str) -> crate::Result<String> {
    let deadline = Instant::now() + LOAD_TIMEOUT;
    let bytes = crate::git::git_bytes(checkout, args, operation, deadline, &|| false, LIST_OUTPUT)
        .map_err(too_large)?;
    Ok(text(bytes))
}

/// Output as text, without a copy when it is valid UTF-8.
fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

/// Lists the focused checkout's changes in `scope`, none of their lines
/// read yet; `base_hint` names the pull request's base branch when one is
/// known. Blocking.
pub(crate) fn load(
    input: &Input,
    scope: Scope,
    base_hint: Option<&str>,
    whitespace: bool,
) -> crate::Result<Loaded> {
    let deadline = Instant::now() + LOAD_TIMEOUT;
    let checkout = crate::pull_request::local_checkout(input, deadline, &|| false)?;
    let (base, revision, before) = match scope {
        Scope::Uncommitted => (None, "HEAD".to_owned(), "HEAD".to_owned()),
        Scope::Branch => {
            let (label, commit) = branch_base(&checkout, base_hint, deadline)?;
            let short: String = commit.chars().take(7).collect();
            let before = format!("{label} at {short}");
            (Some(label), commit, before)
        }
    };
    let source = Source {
        checkout,
        revision,
        whitespace,
    };
    let listing = |format: &'static str, operation| {
        let mut args = vec![
            "-c",
            "core.quotePath=false",
            "diff",
            format,
            "-z",
            "-M",
            "--no-ext-diff",
            "--no-textconv",
        ];
        if source.whitespace {
            args.push("--ignore-all-space");
        }
        args.extend([source.revision.as_str(), "--"]);
        list(&source.checkout, &args, operation)
    };
    let counted = budget::parse_numstat(&listing("--numstat", "count working tree changes")?);
    let statuses: HashMap<String, Status> =
        budget::parse_name_status(&listing("--name-status", "list working tree changes")?)
            .into_iter()
            .collect();
    let root = Path::new(&source.checkout);
    let mut files: Vec<FileDiff> = counted
        .into_iter()
        .map(|counted| {
            let status = statuses
                .get(&counted.path)
                .copied()
                .unwrap_or(Status::Modified);
            let mut file = FileDiff::new(counted.path.clone(), status);
            if let Some(old) = counted.old_path.clone() {
                file.set_old_path(old);
            }
            file.added = counted.added.map(|added| added.min(u32::MAX.into()) as u32);
            file.removed = counted
                .deleted
                .map(|removed| removed.min(u32::MAX.into()) as u32);
            file.body = if counted.binary() {
                Body::Binary
            } else if budget::too_large(counted.lines(), size(root, &counted.path)) {
                Body::Large
            } else {
                Body::Pending
            };
            file
        })
        .collect();
    let untracked = list(
        &source.checkout,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        "list untracked files",
    )?;
    for name in untracked
        .split('\0')
        .filter(|name| inside(name))
        .take(MAX_UNTRACKED)
    {
        let mut file = FileDiff::new(name.to_owned(), Status::Untracked);
        if size(root, name).is_some_and(|bytes| bytes > AUTO_FILE_BYTES) {
            file.body = Body::Large;
        }
        files.push(file);
    }
    // One order for the diff and its file tree, untracked files among
    // the rest: Git's, by path.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let generated = generated(&source.checkout, &files);
    for file in &mut files {
        file.folded = file.status == Status::Deleted
            || lockfile(&file.path)
            || generated.contains(file.git_path.as_str());
    }
    Ok(Loaded {
        source,
        scope,
        base,
        diff: Diff { files, before },
    })
}

/// The files `.gitattributes` marks `linguist-generated`, as GitHub folds
/// them. Asked only when some attributes file mentions it, so a repository
/// without any costs one listing.
fn generated(checkout: &str, files: &[FileDiff]) -> HashSet<String> {
    let mut found = HashSet::new();
    let Ok(attributes) = list(
        checkout,
        &[
            "ls-files",
            "-z",
            "--",
            ":(top,glob)**/.gitattributes",
            ":(top).gitattributes",
        ],
        "list attribute files",
    ) else {
        return found;
    };
    let root = Path::new(checkout);
    let mentioned = attributes
        .split('\0')
        .filter(|name| size(root, name).is_some_and(|bytes| bytes <= 1024 * 1024))
        .any(|name| {
            std::fs::read_to_string(root.join(name))
                .is_ok_and(|text| text.contains("linguist-generated"))
        });
    if !mentioned {
        return found;
    }
    let paths: Vec<&str> = files
        .iter()
        .take(ATTRIBUTE_FILES)
        .map(|file| file.git_path.as_str())
        .collect();
    for chunk in paths.chunks(ATTRIBUTE_CHUNK) {
        let mut args = vec!["check-attr", "-z", "linguist-generated", "--"];
        args.extend(chunk.iter().copied());
        let Ok(output) = list(checkout, &args, "read attributes") else {
            break;
        };
        let mut fields = output.split('\0');
        while let (Some(path), Some(_), Some(value)) = (fields.next(), fields.next(), fields.next())
        {
            if matches!(value, "set" | "true") {
                found.insert(path.to_owned());
            }
        }
    }
    found
}

/// An untracked file's lines, binary, or too large to read without being
/// `asked`. A link is never followed out of the checkout.
pub(super) fn untracked(root: &Path, name: &str, asked: bool) -> Body {
    let limit = if asked {
        ASKED_OUTPUT as u64
    } else {
        AUTO_FILE_BYTES
    };
    let Some(bytes) = size(root, name) else {
        return Body::Failed("Not a regular file".into());
    };
    if bytes > limit {
        return if asked {
            Body::Failed("Too large to show".into())
        } else {
            Body::Large
        };
    }
    let mut contents = Vec::new();
    let read = std::fs::File::open(root.join(name))
        .and_then(|file| file.take(limit).read_to_end(&mut contents));
    if read.is_err() {
        return Body::Failed("Could not read the file".into());
    }
    if contents[..contents.len().min(SNIFF)].contains(&0) {
        return Body::Binary;
    }
    Body::Loaded(Arc::new(Lines::added(&String::from_utf8_lossy(&contents))))
}

/// Reads the lines of `requests`, each paired with its file's index;
/// `asked` lifts the size limits, for a file the user asked to see.
/// Blocking.
pub(crate) fn bodies(source: &Source, requests: &[Request], asked: bool) -> Vec<(usize, Body)> {
    let root = Path::new(&source.checkout);
    let (fresh, tracked): (Vec<&Request>, Vec<&Request>) =
        requests.iter().partition(|request| request.untracked);
    let mut read: Vec<(usize, Body)> = fresh
        .into_iter()
        .map(|request| (request.file, untracked(root, &request.git_path, asked)))
        .collect();
    diff_files(source, &tracked, asked, &mut read);
    read
}

/// Reads tracked files' lines with one Git call, halving the batch when its
/// output is too large, down to the one file that is.
fn diff_files(source: &Source, files: &[&Request], asked: bool, read: &mut Vec<(usize, Body)>) {
    if files.is_empty() {
        return;
    }
    let limit = if asked { ASKED_OUTPUT } else { BATCH_OUTPUT };
    match diff_text(source, files, limit) {
        Ok(text) => {
            let mut parsed: HashMap<String, Body> = parse(&text)
                .into_iter()
                .map(|parsed| (parsed.path, parsed.body))
                .collect();
            for file in files {
                // A file Git printed no lines for, such as one whose only
                // change was whitespace that is ignored, has none to show.
                let body = parsed
                    .remove(&file.git_path)
                    .unwrap_or_else(|| Body::Loaded(Arc::new(Lines::default())));
                read.push((file.file, body));
            }
        }
        Err(crate::Error::PrSize) if files.len() > 1 => {
            let (first, second) = files.split_at(files.len() / 2);
            diff_files(source, first, asked, read);
            diff_files(source, second, asked, read);
        }
        Err(crate::Error::PrSize) => {
            let body = if asked {
                Body::Failed("Too large to show".into())
            } else {
                Body::Large
            };
            read.push((files[0].file, body));
        }
        Err(error) => {
            tracing::warn!(%error, "Could not read changed files");
            for file in files {
                read.push((file.file, Body::Failed("Could not read the change".into())));
            }
        }
    }
}

fn diff_text(source: &Source, files: &[&Request], limit: usize) -> crate::Result<String> {
    // Explicit prefixes and no external tools, whatever the user configured.
    let mut args: Vec<String> = [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ]
    .map(str::to_owned)
    .to_vec();
    if source.whitespace {
        args.push("--ignore-all-space".into());
    }
    args.extend([source.revision.clone(), "--".into()]);
    for file in files {
        args.push(budget::literal(&file.git_path));
        // A rename is only found with both its names.
        if let Some(old) = &file.git_old_path {
            args.push(budget::literal(old));
        }
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let deadline = Instant::now() + LOAD_TIMEOUT;
    let bytes = crate::git::git_bytes(
        &source.checkout,
        &args,
        "read working tree changes",
        deadline,
        &|| false,
        limit,
    )?;
    Ok(text(bytes))
}
