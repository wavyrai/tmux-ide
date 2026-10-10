use super::*;

#[test]
fn github_public_client_id_and_explicit_environment_precedence() -> anyhow::Result<()> {
    assert!(!Config::default().github.allow_plaintext_credentials);
    assert!(
        Config::parse("[github]\nallow_plaintext_credentials = true")?
            .github
            .allow_plaintext_credentials
    );
    assert!(Config::parse("[github]\nallow_plaintext_credentials = 'true'").is_err());
    let config = Config::parse("[github]\noauth_client_id = 'Iv1.fixture'")?;
    assert_eq!(
        config.github.client_id_with_override(None)?.as_deref(),
        Some("Iv1.fixture")
    );
    assert_eq!(
        config
            .github
            .client_id_with_override(Some("override-fixture".as_ref()))?
            .as_deref(),
        Some("override-fixture")
    );
    assert_eq!(
        config.github.oauth_client_id.as_deref(),
        Some("Iv1.fixture")
    );
    assert_eq!(
        Config::default()
            .github
            .client_id_with_override(None)?
            .as_deref(),
        Some("Iv23liurUcwxPjrdIFYT")
    );
    for id in [
        "",
        " ",
        "bad\nvalue",
        "bad/value",
        "\u{e9}",
        &"a".repeat(257),
    ] {
        assert!(matches!(
            config.github.client_id_with_override(Some(id.as_ref())),
            Err(Error::InvalidClientId("HERDR_GITHUB_OAUTH_CLIENT_ID"))
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        assert!(
            config
                .github
                .client_id_with_override(Some(std::ffi::OsStr::from_bytes(b"\xff")))
                .is_err()
        );
    }
    Ok(())
}
