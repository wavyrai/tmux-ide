#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

#[test]
fn saving_writes_only_edited_keys_and_validates_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config-gpui.local.toml");
    fs::write(&path, "theme = 'Nord'\n\n[daytona]\napi_url = 'https://old.example.com/api' # mine\nallow_plaintext_credentials = true\ntarget = 'eu'\n").unwrap();
    let fields = DaytonaFields {
        api_url: "https://app.daytona.io/api".into(),
        snapshot: "daytonaio/sandbox:0.4.3".into(),
        ..DaytonaFields::default()
    };
    Config::save_daytona_path(&fields, &path).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("theme = 'Nord'"));
    assert!(text.contains("api_url = \"https://app.daytona.io/api\" # mine"));
    assert!(text.contains("allow_plaintext_credentials = true"));
    let parsed: toml::Value = toml::from_str(&text).unwrap();
    assert!(
        parsed["daytona"].get("target").is_none(),
        "an emptied key is removed"
    );
    assert!(!text.contains("api_key"), "the key never goes to the file");
    let broken = DaytonaFields {
        api_url: "ftp://daytona.example.com".into(),
        ..DaytonaFields::default()
    };
    assert!(broken.validate(&DaytonaConfig::default()).is_err());
}

#[test]
fn loading_reads_the_table_and_refuses_bad_values() {
    let config = Config::parse("[daytona]\napi_url = \"https://app.daytona.io/api\"\n").unwrap();
    assert_eq!(
        config.daytona.api_url.as_deref(),
        Some("https://app.daytona.io/api")
    );
    assert!(Config::parse("[daytona]\napi_url = \"http://daytona.example.com\"\n").is_err());
    assert!(
        Config::parse("[daytona]\napi_key = \"secret\"\n").is_err(),
        "keys are not file settings"
    );
}
