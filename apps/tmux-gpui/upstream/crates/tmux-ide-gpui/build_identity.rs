use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Default)]
pub struct Identity {
    pub worktree: bool,
    pub branch: String,
    pub detached: bool,
    pub watched: Vec<PathBuf>,
}

fn anchored<'a>(command: &'a mut Command, manifest: &Path) -> &'a mut Command {
    command
        .current_dir(manifest)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    for name in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        command.env_remove(name);
    }
    command
}

fn git(manifest: &Path, args: &[&str]) -> Option<String> {
    let output = anchored(&mut Command::new("git"), manifest)
        .args(args)
        .output()
        .ok()?;
    output.status.success().then_some(())?;
    let output = String::from_utf8(output.stdout).ok()?;
    Some(
        output
            .strip_suffix("\r\n")
            .or_else(|| output.strip_suffix('\n'))
            .unwrap_or(&output)
            .to_owned(),
    )
}

pub fn detect(manifest: &Path) -> Identity {
    let mut identity = Identity::default();
    let Some(dir) = git(manifest, &["rev-parse", "--absolute-git-dir"]).map(PathBuf::from) else {
        return identity;
    };
    let Some(common) = git(
        manifest,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .map(PathBuf::from) else {
        return identity;
    };
    if let Some(root) = git(manifest, &["rev-parse", "--show-toplevel"]) {
        let pointer = Path::new(&root).join(".git");
        if pointer.is_file() {
            identity.watched.push(pointer);
        }
    }
    identity.watched.extend(
        [
            dir.join("HEAD"),
            dir.join("commondir"),
            common.join("packed-refs"),
        ]
        .into_iter()
        .filter(|path| path.is_file()),
    );
    let reference = git(manifest, &["symbolic-ref", "-q", "HEAD"]);
    if let Some(reference) = &reference {
        let path = common.join(reference);
        if path.is_file() {
            identity.watched.push(path);
        } else {
            // A packed or unborn ref may become loose. Watch an existing refs
            // ancestor, never a missing path (which makes Cargo always dirty).
            let refs = common.join("refs");
            if let Some(parent) = path
                .ancestors()
                .skip(1)
                .take_while(|parent| parent.starts_with(&refs))
                .find(|parent| parent.is_dir())
            {
                identity.watched.push(parent.to_owned());
            }
        }
    }
    identity.worktree = match (dir.canonicalize(), common.canonicalize()) {
        (Ok(dir), Ok(common)) => dir != common,
        _ => false,
    };
    if identity.worktree {
        identity.detached = reference.is_none();
        identity.branch = reference
            .and_then(|reference| reference.strip_prefix("refs/heads/").map(str::to_owned))
            .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
            .or_else(|| git(manifest, &["rev-parse", "--short", "HEAD"]))
            .unwrap_or_default();
    }
    identity
}

pub fn validate_pr(value: &str) -> Option<&str> {
    (value.is_empty()
        || (value.bytes().all(|b| b.is_ascii_digit()) && value.bytes().any(|b| b != b'0')))
    .then_some(value)
}

pub fn lookup_pr(manifest: &Path, branch: &str, gh: &Path, timeout: Duration) -> Option<String> {
    let mut child = anchored(&mut Command::new(gh), manifest)
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--limit",
            "1",
            "--json",
            "number",
            "--jq",
            ".[0].number",
        ])
        .env_remove("GH_REPO")
        .env("GH_PROMPT_DISABLED", "1")
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    // A subprocess may leave stdout open in a descendant after exiting. Never
    // block the build on pipe EOF, and never buffer unbounded command output.
    thread::spawn(move || {
        let mut output = String::new();
        let result = stdout.take(128).read_to_string(&mut output).map(|_| output);
        let _ = sender.send(result);
    });
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let output = receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .ok()?
                    .ok()?;
                let value = output.trim();
                return validate_pr(value)
                    .filter(|value| !value.is_empty() && output.len() < 128)
                    .map(str::to_owned);
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
