use super::*;

#[test]
fn signing_identity_is_pinned_to_herdr() -> anyhow::Result<()> {
    assert_eq!(
        signing_identity("Identifier=so.pen.herdr-gpui\nTeamIdentifier=TEAM123\n")?,
        ("TEAM123".into(), "so.pen.herdr-gpui".into())
    );
    assert!(signing_identity("Identifier=another.signed.app\nTeamIdentifier=TEAM123\n").is_err());
    assert!(signing_identity("Identifier=so.pen.herdr-gpui\nTeamIdentifier=not set\n").is_err());
    Ok(())
}

// A requirement that does not compile makes `codesign --verify -R` exit 1
// for every bundle, so the installed app can never be authenticated.
#[cfg(target_os = "macos")]
#[test]
fn designated_requirement_compiles_as_source_text() -> anyhow::Result<()> {
    let cancel = AtomicBool::new(false);
    let directory = tempfile::tempdir()?;
    let compiled = directory.path().join("requirement");
    output(
        Command::new("/usr/bin/csreq")
            .args(["-r", REQUIREMENT, "-b"])
            .arg(&compiled),
        &cancel,
    )?;
    assert!(fs::metadata(&compiled)?.len() > 0);
    assert!(matches!(
        output(
            Command::new("/usr/bin/csreq")
                .args(["-r", &REQUIREMENT[1..], "-b"])
                .arg(directory.path().join("unmarked")),
            &cancel,
        ),
        Err(Error::ValidationFailed(_))
    ));
    Ok(())
}

// csreq proves the text parses; this proves codesign accepts the exact
// argument shape `identity()` builds. Apple signs its own platform
// binaries, so `anchor apple` matches /bin/ls whenever codesign reads the
// argument as source text instead of a requirement file path.
#[cfg(target_os = "macos")]
#[test]
fn codesign_accepts_the_inline_requirement_form() -> anyhow::Result<()> {
    let cancel = AtomicBool::new(false);
    let verify = |requirement: String| {
        output(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict", "-R"])
                .arg(requirement)
                .arg("/bin/ls"),
            &cancel,
        )
    };
    verify(format!("{}anchor apple", &REQUIREMENT[..1]))?;
    assert!(matches!(
        verify("anchor apple".to_owned()),
        Err(Error::ValidationFailed(_))
    ));
    Ok(())
}

// End-to-end proof against a real Developer ID bundle: no fixture can
// satisfy the production requirement, so the installation is named
// explicitly and never discovered.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires an explicit HERDR_TEST_BUNDLE installed Herdr.app"]
fn installed_bundle_satisfies_the_designated_requirement() -> anyhow::Result<()> {
    let cancel = AtomicBool::new(false);
    let bundle = PathBuf::from(
        env::var_os("HERDR_TEST_BUNDLE")
            .context("set HERDR_TEST_BUNDLE to an explicit absolute Herdr.app")?,
    );
    let version = output(
        Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
            .arg(bundle.join("Contents/Info.plist")),
        &cancel,
    )?;
    let (team, identifier) = identity(&bundle, version.trim(), &cancel)?;
    assert_eq!(identifier, "so.pen.herdr-gpui");
    assert!(!team.is_empty());
    assert!(matches!(
        identity(&bundle, "0.0.0", &cancel),
        Err(Error::BundleVersion)
    ));
    Ok(())
}
