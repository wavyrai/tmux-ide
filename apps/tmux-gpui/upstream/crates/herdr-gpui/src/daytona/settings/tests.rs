#![allow(clippy::unwrap_used)]
use super::*;

fn config() -> DaytonaConfig {
    DaytonaConfig {
        api_url: Some("https://app.daytona.io/api/".into()),
        organization_id: Some("org-123".into()),
        target: Some("us".into()),
        snapshot: Some("daytonaio/sandbox:0.4.3".into()),
        ..DaytonaConfig::default()
    }
}

#[test]
fn an_absent_api_url_means_unconfigured() {
    assert!(
        Settings::resolve(&DaytonaConfig::default(), |_| None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn values_are_normalized_and_the_environment_replaces_the_url() {
    let settings = Settings::resolve(&config(), |_| None).unwrap().unwrap();
    assert_eq!(settings.base, "https://app.daytona.io/api");
    assert_eq!(settings.organization.as_deref(), Some("org-123"));
    assert_eq!(
        settings.snapshot.as_deref(),
        Some("daytonaio/sandbox:0.4.3")
    );
    let settings = Settings::resolve(&DaytonaConfig::default(), |name| {
        (name == "HERDR_DAYTONA_API_URL").then(|| "http://127.0.0.1:3000/api".into())
    })
    .unwrap()
    .unwrap();
    assert_eq!(settings.base, "http://127.0.0.1:3000/api");
}

#[test]
fn unsafe_values_are_refused() {
    for broken in [
        DaytonaConfig {
            api_url: Some("http://daytona.example.com/api".into()),
            ..config()
        },
        DaytonaConfig {
            api_url: Some("https://user:pass@daytona.example.com".into()),
            ..config()
        },
        DaytonaConfig {
            organization_id: Some("org\nX-Injected: 1".into()),
            ..config()
        },
        DaytonaConfig {
            target: Some(String::new()),
            ..config()
        },
    ] {
        assert!(Settings::resolve(&broken, |_| None).is_err(), "{broken:?}");
    }
}
