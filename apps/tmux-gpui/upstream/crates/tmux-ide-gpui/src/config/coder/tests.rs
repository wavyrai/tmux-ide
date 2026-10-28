#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

fn fields() -> CoderFields {
    CoderFields {
        url: "https://coder.example.com".into(),
        oauth_client_id: "client-id".into(),
        oauth_redirect_uri: "http://127.0.0.1:47823/callback".into(),
        ..CoderFields::default()
    }
}

#[test]
fn saving_writes_only_edited_keys_and_keeps_the_rest_of_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config-gpui.local.toml");
    fs::write(
        &path,
        "theme = 'Nord' # mine\n\n[coder]\nurl = 'https://old.example.com' # keep note\nallow_plaintext_credentials = true\ncli = '/old/coder'\n",
    )
    .unwrap();
    Config::save_coder_path(&fields(), &path).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("theme = 'Nord' # mine"));
    assert!(text.contains("url = \"https://coder.example.com\" # keep note"));
    assert!(text.contains("allow_plaintext_credentials = true"));
    assert!(!text.contains("oauth_client_secret"));
    let parsed: toml::Value = toml::from_str(&text).unwrap();
    assert!(
        parsed["coder"].get("cli").is_none(),
        "an emptied field removes its key"
    );
    assert_eq!(
        parsed["coder"]["oauth_client_id"].as_str(),
        Some("client-id")
    );

    Config::save_coder_path(&CoderFields::default(), &path).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("allow_plaintext_credentials = true"));
    Config::save_coder_path(&CoderFields::default(), &dir.path().join("fresh.toml")).unwrap();
    let fresh = fs::read_to_string(dir.path().join("fresh.toml")).unwrap();
    assert!(!fresh.contains("[coder]"), "an empty table is not written");
}

#[test]
fn invalid_fields_are_refused_before_anything_is_written_and_secret_is_optional() {
    let existing = CoderConfig::default();
    assert!(fields().validate(&existing).is_ok());
    for broken in [
        CoderFields {
            url: "http://coder.example.com".into(),
            ..fields()
        },
        CoderFields {
            oauth_client_id: "bad id".into(),
            ..fields()
        },
        CoderFields {
            oauth_redirect_uri: "http://127.0.0.1/callback".into(),
            ..fields()
        },
        CoderFields {
            cli: "relative/coder".into(),
            ..fields()
        },
    ] {
        assert!(broken.validate(&existing).is_err(), "{broken:?}");
    }
    assert!(CoderFields::default().validate(&existing).is_ok());
    // HERDR_CODER_OAUTH_* may supply what the file leaves out.
    let partial = CoderFields {
        oauth_client_id: String::new(),
        oauth_redirect_uri: String::new(),
        ..fields()
    };
    assert!(partial.validate(&existing).is_ok());
    let round = CoderFields::from_config(&CoderConfig {
        url: Some("https://coder.example.com".into()),
        cli: Some("/opt/coder".into()),
        ..CoderConfig::default()
    });
    assert_eq!(round.cli, "/opt/coder");
}

#[test]
fn loading_accepts_a_coder_table_the_environment_completes() {
    let config = Config::parse("[coder]\nurl = \"https://coder.example.com\"\n").unwrap();
    assert_eq!(
        config.coder.url.as_deref(),
        Some("https://coder.example.com")
    );
    assert!(Config::parse("[coder]\nurl = \"http://coder.example.com\"\n").is_err());
}
