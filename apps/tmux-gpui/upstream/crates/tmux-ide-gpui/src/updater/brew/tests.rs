use super::*;
// Only the macOS-only opt-in tests below use it.
#[cfg(target_os = "macos")]
use anyhow::Context as _;
use std::os::unix::fs::{PermissionsExt, symlink};

mod relaunch;

/// A Homebrew prefix that owns `target`, returning the artifact link.
fn caskroom(prefix: &Path, version: &str, target: &Path) -> anyhow::Result<PathBuf> {
    let bin = prefix.join("bin");
    fs::create_dir_all(&bin)?;
    fs::write(bin.join("brew"), b"#!/bin/sh\nexit 0\n")?;
    fs::set_permissions(bin.join("brew"), fs::Permissions::from_mode(0o755))?;
    let versioned = prefix.join("Caskroom").join(TOKEN).join(version);
    fs::create_dir_all(&versioned)?;
    let link = versioned.join(BUNDLE);
    symlink(target, &link)?;
    Ok(link)
}

#[test]
fn detection_requires_homebrew_to_own_this_exact_bundle() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let root = root.path().canonicalize()?;
    let prefix = root.join("prefix");
    let bundle = root.join("Applications/Herdr.app");
    let other = root.join("Applications/Other.app");
    fs::create_dir_all(&bundle)?;
    fs::create_dir_all(&other)?;
    let uid = fs::metadata(&root)?.uid();
    let found = |bundle: &Path| {
        locate(bundle, uid, root.clone().into(), [prefix.clone()]).map(|cask| cask.brew)
    };
    assert!(found(&bundle).is_none(), "no Caskroom yet");

    let link = caskroom(&prefix, "20260921.1", &other)?;
    assert!(found(&bundle).is_none(), "cask owns another bundle");
    fs::remove_file(&link)?;
    symlink(&bundle, &link)?;
    assert_eq!(found(&bundle), Some(prefix.join("bin/brew")));

    let brew = prefix.join("bin/brew");
    fs::set_permissions(&brew, fs::Permissions::from_mode(0o777))?;
    assert!(found(&bundle).is_none(), "world-writable brew");
    fs::set_permissions(&brew, fs::Permissions::from_mode(0o755))?;
    fs::set_permissions(&prefix, fs::Permissions::from_mode(0o777))?;
    assert!(found(&bundle).is_none(), "world-writable prefix");
    fs::set_permissions(&prefix, fs::Permissions::from_mode(0o755))?;
    assert!(found(&bundle).is_some());

    fs::remove_file(&brew)?;
    assert!(found(&bundle).is_none(), "no brew executable");
    Ok(())
}

fn cask(script: &str, root: &Path) -> anyhow::Result<Cask> {
    let brew = root.join("brew");
    // Write in a single-threaded child: a concurrent test's fork must not
    // inherit a writable handle to this executable (Linux ETXTBSY).
    let status = Command::new("/bin/sh")
        .args([
            "-c",
            "printf '%s' \"$1\" > \"$2\"",
            "write-brew-fixture",
            script,
        ])
        .arg(&brew)
        .status()?;
    anyhow::ensure!(status.success(), "writing brew fixture failed: {status}");
    fs::set_permissions(&brew, fs::Permissions::from_mode(0o755))?;
    Ok(Cask {
        brew,
        prefix: root.to_owned(),
        bundle: root.join(BUNDLE),
        home: root.into(),
    })
}

// The real Homebrew layout is the contract this module reads; a fixture
// cannot prove Homebrew still records casks the way detection expects.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires an explicit HERDR_TEST_BUNDLE installed from the cask"]
fn the_real_cask_is_detected_and_reports_its_version() -> anyhow::Result<()> {
    let bundle = PathBuf::from(
        env::var_os("HERDR_TEST_BUNDLE")
            .context("set HERDR_TEST_BUNDLE to an explicit absolute Herdr.app")?,
    );
    let uid = super::super::install::effective_uid()?;
    let cask = detect(&bundle, uid).context("Homebrew does not own this bundle")?;
    let version = installed(&cask, QUERY)?;
    assert!(
        release::parse_version(&version).is_some(),
        "{version} is a release version"
    );
    // A bundle Homebrew did not install must never be treated as managed.
    assert!(detect(&bundle.join("Contents"), uid).is_none());

    // The real upgrade, resolved but not performed: proof that the minimal
    // environment is enough for Homebrew to auto-update its taps and plan
    // the cask, which a fixture shell script cannot show.
    let mut dry = command(&cask);
    dry.args(["upgrade", "--cask", "--dry-run", TOKEN]);
    let lines = run(dry, UPGRADE, None, |line| println!("{line}"))?;
    assert!(
        lines.iter().any(|line| line.contains(TOKEN)),
        "Homebrew resolved the cask: {lines:?}"
    );
    Ok(())
}

// Actually upgrades the installed app, so it is opt-in twice over: past
// `--ignored` and past an explicit request. `just test-update` must not
// sweep it up; `just test-brew-upgrade` runs it on purpose.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "upgrades the installed app; set HERDR_TEST_BREW_UPGRADE, HERDR_TEST_BUNDLE and HERDR_TEST_BREW_EXPECTED"]
fn homebrew_really_installs_a_newer_release() -> anyhow::Result<()> {
    let bundle = PathBuf::from(
        env::var_os("HERDR_TEST_BUNDLE")
            .context("set HERDR_TEST_BUNDLE to an explicit absolute Herdr.app")?,
    );
    env::var_os("HERDR_TEST_BREW_UPGRADE")
        .context("set HERDR_TEST_BREW_UPGRADE=1 to really upgrade this installation")?;
    let expected = env::var("HERDR_TEST_BREW_EXPECTED")
        .context("set HERDR_TEST_BREW_EXPECTED to the offered YYYYMMDD.COUNTER release")?;
    let uid = super::super::install::effective_uid()?;
    let cask = detect(&bundle, uid).context("Homebrew does not own this bundle")?;
    let before = installed(&cask, QUERY)?;
    let cancel = AtomicBool::new(false);
    let mut lines = 0;
    let after = upgrade(&cask, &before, &expected, &cancel, |line| {
        lines += 1;
        println!("{line}");
    })?;
    assert!(lines > 1, "the upgrade reported progress");
    assert!(
        release::parse_version(&after) > release::parse_version(&before),
        "{before} -> {after}"
    );
    assert!(release::parse_version(&after) >= release::parse_version(&expected));
    assert_eq!(
        installed(&cask, QUERY)?,
        after,
        "Homebrew records the new version"
    );
    // Homebrew owns the same bundle afterwards, so the next check still
    // delegates instead of falling back to replacing a managed install.
    assert!(detect(&bundle, uid).is_some());
    // Running it again cannot claim a second update.
    assert!(matches!(
        upgrade(&cask, &after, &expected, &cancel, |_| ()),
        Err(Error::BrewStale { installed, .. }) if installed == after
    ));
    Ok(())
}

#[test]
fn progress_is_bounded_and_failures_keep_the_last_line() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let noisy = cask(
        "#!/bin/sh\nfor i in $(seq 1 200); do echo \"line $i\"; done\necho 'boom' >&2\nexit 3\n",
        root.path(),
    )?;
    let mut seen = Vec::new();
    let Err(error) = run(command(&noisy), QUERY, None, |line| seen.push(line)) else {
        anyhow::bail!("a non-zero exit must fail");
    };
    // Every line, whichever side of the child's exit it was read on: a
    // command this short can exit with all of it still in flight.
    let mut expected: Vec<String> = (1..=200).map(|i| format!("line {i}")).collect();
    expected.push("boom".to_owned());
    seen.sort();
    expected.sort();
    assert_eq!(seen, expected, "every line is reported as progress");
    assert!(matches!(&error, Error::BrewFailed { status, detail }
            if status.code() == Some(3) && !detail.is_empty() && detail.len() <= DETAIL));

    // A line that only reaches the pipe after the process exits is still
    // that process's output: the grandchild keeps the pipe open past the
    // exit, so this line can be read only while draining.
    let late = cask(
        "#!/bin/sh\n( sleep 1; echo 'after exit' ) &\necho 'before exit'\nexit 3\n",
        root.path(),
    )?;
    let mut seen = Vec::new();
    let Err(error) = run(command(&late), QUERY, None, |line| seen.push(line)) else {
        anyhow::bail!("a non-zero exit must fail");
    };
    assert_eq!(seen, ["before exit", "after exit"], "drained lines report");
    assert!(
        matches!(&error, Error::BrewFailed { detail, .. } if detail == "after exit"),
        "the detail is the last line produced, not the last one read before \
             the exit: {error:?}"
    );

    let long = cask(
        &format!("#!/bin/sh\necho '{}'\n", "x".repeat(4096)),
        root.path(),
    )?;
    let lines = run(command(&long), QUERY, None, |_| ())?;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].len(), DETAIL, "detail is truncated");

    let control = cask("#!/bin/sh\nprintf '\\033[31mred\\033[0m\\n'\n", root.path())?;
    assert_eq!(
        run(command(&control), QUERY, None, |_| ())?,
        vec!["[31mred[0m".to_owned()],
        "escape bytes are stripped, never rendered"
    );
    Ok(())
}

#[test]
fn timeout_cancellation_and_version_parsing() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let slow = cask("#!/bin/sh\nsleep 30\n", root.path())?;
    assert!(matches!(
        run(command(&slow), Duration::from_millis(200), None, |_| ()),
        Err(Error::BrewTimeout)
    ));
    let cancel = AtomicBool::new(true);
    assert!(matches!(
        run(command(&slow), QUERY, Some(&cancel), |_| ()),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        upgrade(&slow, "20260921.1", "20260921.2", &cancel, |_| ()),
        Err(Error::Cancelled)
    ));

    let listed = cask(
        &format!("#!/bin/sh\necho 'other 1.2'\necho '{TOKEN} 20260921.2'\n"),
        root.path(),
    )?;
    assert_eq!(installed(&listed, QUERY)?, "20260921.2");
    let empty = cask("#!/bin/sh\necho 'nothing here'\n", root.path())?;
    assert!(matches!(installed(&empty, QUERY), Err(Error::BrewVersion)));
    Ok(())
}

/// State is private to the fixture HOME; no shell environment is inherited
/// and no real Homebrew command can be reached.
fn fake_brew(root: &Path, first: &str, refreshed: &str, fail: &str) -> anyhow::Result<Cask> {
    cask(
        &format!(
            r#"#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$HOME/commands"
[ "$PATH" = "$HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin" ] || exit 90
[ "$LC_ALL" = C ] || exit 91
[ "$HOMEBREW_NO_ANALYTICS" = 1 ] || exit 92
phase="$1"
if [ "$1" = upgrade ]; then
    if [ -f "$HOME/refreshed" ]; then
        phase=retry
        [ "${{HOMEBREW_NO_AUTO_UPDATE:-}}" = 1 ] || exit 93
    else
        [ -z "${{HOMEBREW_NO_AUTO_UPDATE:-}}" ] || exit 94
    fi
fi
if [ "$phase" = '{fail}' ]; then
    printf '%s failed\n' "$phase" >&2
    exit 3
fi
case "$*" in
    'upgrade --cask {TOKEN}') printf 'upgrade output\n' ;;
    update) : > "$HOME/refreshed" ;;
    'list --cask --versions {TOKEN}')
        if [ -f "$HOME/refreshed" ]; then
            printf '{TOKEN} {refreshed}\n'
        else
            printf '{TOKEN} {first}\n'
        fi ;;
    *) exit 95 ;;
esac
"#
        ),
        root,
    )
}

const FIRST_ATTEMPT: &str = "upgrade --cask herdr-gpui\nlist --cask --versions herdr-gpui\n";
const RECOVERY: &str = "upgrade --cask herdr-gpui\nlist --cask --versions herdr-gpui\nupdate\nupgrade --cask herdr-gpui\nlist --cask --versions herdr-gpui\n";

#[test]
fn reaching_or_exceeding_the_offer_needs_no_refresh() -> anyhow::Result<()> {
    for version in ["20260921.3", "20260921.10", "20260922.1"] {
        let root = tempfile::tempdir()?;
        let cask = fake_brew(root.path(), version, "unused", "")?;
        assert_eq!(
            upgrade(
                &cask,
                "20260921.1",
                "20260921.3",
                &AtomicBool::new(false),
                |_| ()
            )?,
            version
        );
        assert_eq!(
            fs::read_to_string(root.path().join("commands"))?,
            FIRST_ATTEMPT
        );
    }
    Ok(())
}

#[test]
fn stale_or_intermediate_versions_refresh_and_retry_once() -> anyhow::Result<()> {
    for first in ["20260921.1", "20260921.2"] {
        let root = tempfile::tempdir()?;
        let cask = fake_brew(root.path(), first, "20260921.3", "")?;
        let mut progress = Vec::new();
        assert_eq!(
            upgrade(
                &cask,
                "20260921.1",
                "20260921.3",
                &AtomicBool::new(false),
                |line| progress.push(line)
            )?,
            "20260921.3"
        );
        assert_eq!(fs::read_to_string(root.path().join("commands"))?, RECOVERY);
        assert_eq!(
            progress,
            [
                "Asking Homebrew to upgrade the cask...",
                "upgrade output",
                "Checking the installed Homebrew cask version...",
                "Refreshing Homebrew metadata with brew update...",
                "Retrying Homebrew cask upgrade after refresh...",
                "upgrade output",
                "Checking the installed Homebrew cask version...",
            ]
        );
    }
    Ok(())
}

#[test]
fn persistent_staleness_reports_the_final_version_and_offer() -> anyhow::Result<()> {
    for (current, first, final_version, expected) in [
        ("20260921.1", "20260921.1", "20260921.1", "20260921.3"),
        ("20260921.1", "20260921.1", "20260921.2", "20260921.3"),
        ("20260921.3", "20260921.3", "20260921.3", "20260921.3"),
    ] {
        let root = tempfile::tempdir()?;
        let cask = fake_brew(root.path(), first, final_version, "")?;
        let result = upgrade(&cask, current, expected, &AtomicBool::new(false), |_| ());
        assert!(
            matches!(result, Err(Error::BrewStale { installed, current: old, expected: offer })
            if installed == final_version && old == current && offer == expected)
        );
        assert_eq!(fs::read_to_string(root.path().join("commands"))?, RECOVERY);
    }
    Ok(())
}

#[test]
fn command_failures_never_trigger_recovery_or_another_retry() -> anyhow::Result<()> {
    for (fail, commands) in [
        ("upgrade", "upgrade --cask herdr-gpui\n".to_owned()),
        ("list", FIRST_ATTEMPT.to_owned()),
        ("update", format!("{FIRST_ATTEMPT}update\n")),
        (
            "retry",
            format!("{FIRST_ATTEMPT}update\nupgrade --cask herdr-gpui\n"),
        ),
    ] {
        let root = tempfile::tempdir()?;
        let cask = fake_brew(root.path(), "20260921.1", "20260921.3", fail)?;
        let result = upgrade(
            &cask,
            "20260921.1",
            "20260921.3",
            &AtomicBool::new(false),
            |_| (),
        );
        assert!(
            matches!(&result, Err(Error::BrewFailed { status, detail })
            if status.code() == Some(3) && detail == &format!("{fail} failed")),
            "{fail}: {result:?}"
        );
        assert_eq!(fs::read_to_string(root.path().join("commands"))?, commands);
    }
    Ok(())
}

#[test]
fn cancellation_before_spawn_runs_nothing_but_mutation_is_not_interrupted() -> anyhow::Result<()> {
    for already_cancelled in [true, false] {
        let root = tempfile::tempdir()?;
        let cask = fake_brew(root.path(), "20260921.1", "20260921.3", "")?;
        let cancel = AtomicBool::new(already_cancelled);
        let result = upgrade(&cask, "20260921.1", "20260921.3", &cancel, |_| {
            cancel.store(true, Ordering::Release);
        });
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(!root.path().join("commands").exists());
    }

    let root = tempfile::tempdir()?;
    let cask = fake_brew(root.path(), "20260921.1", "20260921.3", "")?;
    let cancel = AtomicBool::new(false);
    assert_eq!(
        upgrade(&cask, "20260921.1", "20260921.3", &cancel, |line| {
            if line == "upgrade output" {
                cancel.store(true, Ordering::Release);
            }
        })?,
        "20260921.3"
    );
    assert!(cancel.load(Ordering::Acquire));
    assert_eq!(fs::read_to_string(root.path().join("commands"))?, RECOVERY);
    Ok(())
}

#[test]
fn exhausted_budget_does_not_spawn_another_command() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let cask = fake_brew(root.path(), "20260921.1", "20260921.3", "")?;
    assert!(matches!(
        run(command(&cask), Duration::ZERO, None, |_| ()),
        Err(Error::BrewTimeout)
    ));
    assert!(matches!(
        installed(&cask, Duration::ZERO),
        Err(Error::BrewTimeout)
    ));
    assert!(!root.path().join("commands").exists());
    Ok(())
}
