use super::*;
use crate::usage::{
    model::{SESSION, Section},
    probe::{Response, json_field},
    providers::{claude, codex},
};

/// Trimmed from a live response: model windows only appear in `limits`.
const CLAUDE: &str = r#"{"five_hour":{"utilization":3.0,"resets_at":"2026-09-25T08:20:00.978246+00:00"},
"seven_day":{"utilization":15.0,"resets_at":"2026-09-29T16:59:59+00:00"},
"extra_usage":{"is_enabled":false},
"limits":[
 {"kind":"session","group":"session","percent":3,"resets_at":"2026-09-25T08:20:00+00:00","scope":null},
 {"kind":"weekly_all","group":"weekly","percent":15,"resets_at":"2026-09-29T16:59:59+00:00","scope":null},
 {"kind":"weekly_scoped","group":"weekly","percent":0,"resets_at":"2026-09-29T17:00:00+00:00",
  "scope":{"model":{"id":null,"display_name":"Fable"},"surface":null}},
 {"kind":"monthly_spend","percent":50,"resets_at":null}
],
"spend":{"used":{"amount_minor":1234,"currency":"EUR","exponent":2},
 "limit":{"amount_minor":5000,"currency":"EUR","exponent":2},"enabled":true},
"seven_day_breakdown":{"rows":[{"key":"claude_code","display_name":"Claude Code","percent":90},
 {"key":"chat","display_name":"Chats","percent":10},{"key":"other","display_name":"Other","percent":0}]}}"#;

#[test]
fn claude_reads_every_window_account_and_detail() {
    let report = claude::parse(
        CLAUDE,
        claude::SignIn {
            plan: Some("max".into()),
            tier: Some("default_claude_max_20x".into()),
            email: Some("me@example.com".into()),
        },
    )
    .unwrap();
    assert_eq!(report.provider, provider("claude"));
    let windows: Vec<_> = report
        .windows
        .iter()
        .map(|w| (w.kind.clone(), w.percent(), w.length))
        .collect();
    assert_eq!(
        windows,
        [
            (Kind::Session, 3, Some(SESSION)),
            (Kind::Weekly, 15, Some(WEEK)),
            (Kind::Named("Fable".into()), 0, Some(WEEK)),
        ]
    );
    assert_eq!(report.windows[0].resets_at, Some(at(1_790_324_400)));
    assert_eq!(
        report.account,
        Account {
            email: Some("me@example.com".into()),
            plan: Some("Max 20x".into()),
        }
    );
    assert_eq!(
        report.sections,
        [
            Section::Shares {
                title: "This week by surface".into(),
                shares: vec![("Claude Code".into(), 90.), ("Chats".into(), 10.)],
            },
            Section::Facts {
                title: "Extra usage".into(),
                facts: vec![("This month".into(), "12.34 EUR of 50.00 EUR".into())],
            },
        ]
    );
}

#[test]
fn claude_falls_back_to_the_fixed_windows() {
    let body = r#"{"five_hour":{"utilization":42.4,"resets_at":1790324400},
        "seven_day":{"utilization":150,"resets_at":null},"limits":null,
        "spend":{"enabled":false}}"#;
    let report = claude::parse(body, claude::SignIn::default()).unwrap();
    assert_eq!(report.windows[0].kind, Kind::Session);
    assert_eq!(report.windows[0].percent(), 42);
    // Clamped: a service rounding past its own limit still reads as full.
    assert_eq!(report.windows[1].percent(), 100);
    assert_eq!(report.windows[1].left(), 0);
    assert_eq!(report.account, Account::default());
}

#[test]
fn claude_plans_name_their_tier_multiple() {
    assert_eq!(
        claude::plan(Some("max"), Some("default_claude_max_20x")).as_deref(),
        Some("Max 20x")
    );
    assert_eq!(
        claude::plan(Some("pro"), Some("default_claude_ai")).as_deref(),
        Some("Pro")
    );
    assert_eq!(claude::plan(None, Some("default_claude_max_5x")), None);
}

/// Live shape: a Pro plan with only a weekly limit, in the primary slot.
const CODEX: &str = r#"{"email":"me@example.com","plan_type":"pro","rate_limit":{"allowed":true,
    "primary_window":{"used_percent":11,"limit_window_seconds":604800,"reset_after_seconds":472393,
    "reset_at":1790786634},"secondary_window":null},
    "code_review_rate_limit":{"primary_window":{"used_percent":4,"limit_window_seconds":604800,
    "reset_at":1790786634},"secondary_window":null},
    "credits":{"has_credits":false,"unlimited":false,"balance":"0"},
    "rate_limit_reset_credits":{"available_count":2,"applicable_available_count":0}}"#;

#[test]
fn codex_windows_are_known_by_length_not_slot() {
    let report = codex::parse(CODEX).unwrap();
    assert_eq!(report.provider, provider("codex"));
    assert_eq!(report.account.plan.as_deref(), Some("Pro"));
    assert_eq!(report.windows.len(), 1);
    assert_eq!(report.windows[0].kind, Kind::Weekly);
    assert_eq!(report.windows[0].resets_at, Some(at(1_790_786_634)));
    assert_eq!(report.sections.len(), 3);

    let report = codex::parse(
        r#"{"plan_type":"plus","rate_limit":{
        "primary_window":{"used_percent":70,"limit_window_seconds":1,"reset_at":1790000000000},
        "secondary_window":{"used_percent":90,"reset_at":null}}}"#,
    )
    .unwrap();
    assert_eq!(report.windows[0].kind, Kind::Session);
    assert_eq!(report.windows[0].resets_at, Some(at(1_790_000_000)));
    assert_eq!(report.windows[1].kind, Kind::Weekly);
}

#[test]
fn statuses_become_typed_errors_without_echoing_the_body() {
    let response = |status| Response {
        status,
        body: "secret@example.com".into(),
    };
    assert!(matches!(response(0).ok(), Err(Error::UsageConnect)));
    assert!(matches!(response(401).ok(), Err(Error::UsageRejected)));
    assert!(matches!(response(403).ok(), Err(Error::UsageRejected)));
    assert!(matches!(response(429).ok(), Err(Error::UsageRateLimited)));
    assert!(matches!(response(500).ok(), Err(Error::UsageStatus(500))));
    assert_eq!(response(204).ok().unwrap(), "secret@example.com");
    let error = codex::parse(r#"{"plan_type": "secret@example.com"#).unwrap_err();
    assert!(matches!(
        error,
        Error::UsageJson(serde_json::error::Category::Eof)
    ));
    assert!(!error.to_string().contains("secret"));
}

#[test]
fn every_provider_is_registered_once_with_its_icon() {
    let ids: Vec<_> = registry::all().map(|p| p.id()).collect();
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), ids.len(), "duplicate provider id");
    assert!(ids.len() >= 87);
    for provider in registry::all() {
        assert!(
            provider
                .id()
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
            "{}",
            provider.id()
        );
        let icon = provider.icon();
        assert!(
            super::super::icon(icon).is_some() || icon.starts_with("icons/agent-"),
            "{} has no icon at {icon}",
            provider.id()
        );
        for url in provider
            .service()
            .meta()
            .dashboard
            .into_iter()
            .chain(provider.service().meta().status_page)
        {
            assert!(url.starts_with("https://"), "{url}");
        }
        for setting in provider.service().meta().settings {
            assert!(
                !setting.help.trim().is_empty(),
                "{}.{}",
                provider.id(),
                setting.name
            );
        }
    }
}

#[test]
fn json_fields_follow_paths_through_objects_and_arrays() {
    let text = r#"{"a":{"b":[{"c":"x"},{"c":7}]},"t":true,"n":null}"#;
    assert_eq!(
        json_field(text, &["a", "b", "0", "c"]).as_deref(),
        Some("x")
    );
    assert_eq!(
        json_field(text, &["a", "b", "1", "c"]).as_deref(),
        Some("7")
    );
    assert_eq!(json_field(text, &["t"]).as_deref(), Some("true"));
    assert_eq!(json_field(text, &["n"]), None);
    assert_eq!(json_field(text, &["a"]), None);
    assert_eq!(json_field("not json", &["a"]), None);
}
