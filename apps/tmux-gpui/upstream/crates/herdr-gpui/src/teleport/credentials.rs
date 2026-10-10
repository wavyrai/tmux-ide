//! Let a teleported checkout pull and push when its host cannot reach GitHub
//! on its own (no SSH key there, or an unknown host key).
//!
//! The token comes from `gh auth token` on this machine and reaches the host
//! only through a script's stdin, never an argument or a log line. It is kept
//! in the repository's Git directory (`<common dir>/herdr/github-token`, mode
//! 600), so it is never part of a working tree or a commit, and every worktree
//! of the repository shares it. A repository-local credential helper reads it
//! for `https://github.com`, and SSH remote URLs are rewritten to HTTPS for
//! that repository only. `.envrc` exports `GH_TOKEN` from the same file for
//! `gh` under direnv, unless the repository tracks its own `.envrc`.

use super::{
    error::{Error, Result, Step},
    host::Host,
    remote::RemoteId,
};
use herdr_client::{ConnectTarget, shell_quote};
use std::sync::atomic::AtomicBool;

/// Whether `origin` names a GitHub repository.
pub(crate) fn is_github(origin: &str) -> bool {
    RemoteId::parse(origin).is_some_and(|id| id.host() == "github.com")
}

/// Whether `host` can list `origin` without any prompt.
pub(crate) fn reachable(host: &Host, origin: &str, cancelled: &AtomicBool) -> Result<bool> {
    let body = format!(
        r#"GIT_TERMINAL_PROMPT=0
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
export GIT_TERMINAL_PROMPT GIT_SSH_COMMAND
if git ls-remote -q --heads -- {origin} </dev/null >/dev/null 2>&1; then echo yes; else echo no; fi
"#,
        origin = shell_quote(origin)
    );
    let output = host.query(Step::Review, &body, &[], cancelled)?;
    Ok(output.starts_with(b"yes"))
}

/// This machine's GitHub token from the GitHub CLI, if it is signed in.
pub(crate) fn local_token(cancelled: &AtomicBool) -> Result<Option<String>> {
    let local = Host::new(&ConnectTarget::Local)?;
    let output = local.query(
        Step::Credentials,
        "gh auth token --hostname github.com 2>/dev/null || :\n",
        &[],
        cancelled,
    )?;
    let token = String::from_utf8_lossy(&output).trim().to_owned();
    Ok(valid_token(&token).then_some(token))
}

/// GitHub tokens are short, printable, and single-line.
fn valid_token(token: &str) -> bool {
    (8..=512).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

/// What installing left out, for the user to hear about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Installed {
    Complete,
    /// The repository tracks `.envrc`, so `GH_TOKEN` was not added to it.
    WithoutEnvrc,
}

/// Install `token` for the repository checked out at `checkout` on `host`.
/// Safe to repeat: every setting is replaced, not appended.
pub(crate) fn install(
    host: &Host,
    checkout: &str,
    token: &str,
    cancelled: &AtomicBool,
) -> Result<Installed> {
    if !valid_token(token) {
        return Err(Error::InvalidToken);
    }
    // The helper and .envrc read the file each time, so rotating the token
    // is rewriting one file; neither ever holds the token itself.
    let read =
        r#"$(cat "$(git rev-parse --path-format=absolute --git-common-dir)/herdr/github-token")"#;
    let helper = format!(
        r#"!f() {{ test "$1" = get || exit 0; echo username=x-access-token; printf 'password=%s\n' "{read}"; }}; f"#
    );
    let envrc = format!(r#"export GH_TOKEN="{read}" # herdr teleport"#);
    let body = format!(
        r#"cd -- {checkout}
dir="$(git rev-parse --path-format=absolute --git-common-dir)/herdr"
umask 077
mkdir -p -- "$dir"
IFS= read -r token || [ -n "$token" ]
printf '%s\n' "$token" > "$dir/github-token.tmp"
chmod 600 "$dir/github-token.tmp"
mv -f -- "$dir/github-token.tmp" "$dir/github-token"
g() {{ git config --local "$@"; }}
g --unset-all credential.https://github.com.helper 2>/dev/null || :
# An empty entry first clears helpers from other configuration files.
g --add credential.https://github.com.helper ''
g --add credential.https://github.com.helper {helper}
g --unset-all url.https://github.com/.insteadOf 2>/dev/null || :
g --add url.https://github.com/.insteadOf git@github.com:
g --add url.https://github.com/.insteadOf ssh://git@github.com/
if git ls-files --error-unmatch .envrc >/dev/null 2>&1; then
    echo tracked-envrc
    exit 0
fi
grep -qF '# herdr teleport' .envrc 2>/dev/null || printf '%s\n' {envrc} >> .envrc
chmod 600 .envrc
if ! git check-ignore -q .envrc; then
    printf '%s\n' .envrc >> "$(git rev-parse --path-format=absolute --git-path info/exclude)"
fi
if command -v direnv >/dev/null 2>&1; then direnv allow . >/dev/null 2>&1 || :; fi
"#,
        checkout = shell_quote(checkout),
        helper = shell_quote(&helper),
        envrc = shell_quote(&envrc),
    );
    let output = host.query(
        Step::Credentials,
        &body,
        format!("{token}\n").as_bytes(),
        cancelled,
    )?;
    Ok(if output.starts_with(b"tracked-envrc") {
        Installed::WithoutEnvrc
    } else {
        Installed::Complete
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_github_origins_and_plain_tokens_qualify() {
        assert!(is_github("git@github.com:me/app.git"));
        assert!(is_github("https://github.com/me/app"));
        assert!(!is_github("git@gitlab.com:me/app.git"));
        assert!(!is_github("/srv/app.git"));
        assert!(valid_token("gho_16C7e42F292c6912E7710c838347Ae178B4a"));
        assert!(valid_token("github_pat_11ABC_def-ghi.jkl"));
        assert!(!valid_token(""));
        assert!(!valid_token("short"));
        assert!(!valid_token("gho_abc\nrm -rf /"));
        assert!(!valid_token("gho_abc'$(x)'"));
    }
}

// Host scripts need /bin/sh; Teleport is not offered on other clients.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unwrap_used)]
mod git_tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        os::unix::fs::PermissionsExt,
        path::Path,
        process::{Command, Stdio},
    };

    fn git(dir: &Path, args: &[&str], input: Option<&str>) -> String {
        let mut child = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn host(home: &Path) -> Host {
        let mut host = Host::new(&ConnectTarget::Local).unwrap();
        host.env = vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ];
        host
    }

    #[test]
    fn an_installed_token_answers_git_and_never_enters_the_tree() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("app");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"], None);
        git(
            &repo,
            &["remote", "add", "origin", "git@github.com:me/app.git"],
            None,
        );
        let host = host(temp.path());
        let cancelled = AtomicBool::new(false);
        let token = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
        let checkout = repo.to_str().unwrap();
        assert_eq!(
            install(&host, checkout, token, &cancelled).unwrap(),
            Installed::Complete
        );
        // Twice is the same as once.
        assert_eq!(
            install(&host, checkout, token, &cancelled).unwrap(),
            Installed::Complete
        );

        let file = repo.join(".git/herdr/github-token");
        assert_eq!(fs::read_to_string(&file).unwrap(), format!("{token}\n"));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let filled = git(
            &repo,
            &["credential", "fill"],
            Some("protocol=https\nhost=github.com\n\n"),
        );
        assert!(filled.contains("username=x-access-token"), "{filled}");
        assert!(filled.contains(&format!("password={token}")), "{filled}");
        // The SSH remote now goes over HTTPS, where the helper answers.
        let url = git(&repo, &["ls-remote", "--get-url", "origin"], None);
        assert_eq!(url.trim(), "https://github.com/me/app.git");

        let envrc = fs::read_to_string(repo.join(".envrc")).unwrap();
        assert_eq!(envrc.matches("# herdr teleport").count(), 1, "{envrc}");
        assert!(!envrc.contains(token), "the token stays out of .envrc");
        git(&repo, &["check-ignore", "-q", ".envrc"], None);
        assert!(git(&repo, &["status", "--porcelain"], None).is_empty());
    }

    #[test]
    fn a_tracked_envrc_is_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("app");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"], None);
        fs::write(repo.join(".envrc"), "use nix\n").unwrap();
        git(&repo, &["add", ".envrc"], None);
        let installed = install(
            &host(temp.path()),
            repo.to_str().unwrap(),
            "gho_16C7e42F292c6912E7710c838347Ae178B4a",
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(installed, Installed::WithoutEnvrc);
        assert_eq!(
            fs::read_to_string(repo.join(".envrc")).unwrap(),
            "use nix\n"
        );
        assert!(matches!(
            install(
                &host(temp.path()),
                repo.to_str().unwrap(),
                "bad token",
                &AtomicBool::new(false)
            ),
            Err(Error::InvalidToken)
        ));
    }
}
