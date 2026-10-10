use super::*;

const QUOTA: &str = r#"{"virtual_key_name":"fixture-team","budgets":[
      {"id":"year","max_limit":1000,"current_usage":100,"reset_duration":"1Y"},
      {"id":"month","max_limit":125,"current_usage":42.17,"reset_duration":"1M",
       "last_reset":"2026-09-01T00:00:00Z","source_name":"Engineering",
       "per_model_usage":[
         {"model":"gpt-4o","provider":"openai","total_cost":5,"total_tokens":1200000},
         {"model":"fixture-empty","provider":"openai","total_cost":0,"total_tokens":0}]}],
     "rate_limit":{"id":"rl_1","token_max_limit":1000000,"token_current_usage":345678,
                   "token_reset_duration":"1d","request_max_limit":5000,"request_current_usage":120},
     "rate_limits":[{"id":"rl_1","token_max_limit":1000000,"token_current_usage":345678,
                     "token_reset_duration":"1d","request_max_limit":5000,"request_current_usage":120},
                    {"id":"rl_2","source_name":"Team pool","token_max_limit":200000,
                     "token_current_usage":100,"request_reset_duration":"1h"}]}"#;

fn now() -> SystemTime {
    Timestamp::Text("2026-09-24T12:00:00Z".into())
        .time()
        .unwrap()
}

#[test]
fn parses_budgets_limits_and_models() {
    let report = parse(QUOTA, now()).unwrap();
    assert_eq!(report.account.email.as_deref(), Some("fixture-team"));
    assert_eq!(report.account.plan.as_deref(), Some("Engineering"));
    assert_eq!(report.windows.len(), 2);
    let month = report
        .windows
        .iter()
        .find(|window| window.kind == Kind::Named("Engineering · Monthly".into()))
        .unwrap();
    assert!((month.used - 33.736).abs() < 0.001);
    assert_eq!(month.resets_at, None);
    assert_eq!(report.balances[0].label, "Monthly");
    assert_eq!(report.balances[0].amount, 42.17);
    assert_eq!(report.balances[0].total, Some(125.));
    let limits: Vec<_> = report
        .sections
        .iter()
        .filter_map(|section| match section {
            Section::Limit(window) => Some((window.kind.title().to_owned(), window.percent())),
            _ => None,
        })
        .collect();
    assert_eq!(
        limits,
        [
            ("Tokens".to_owned(), 35),
            ("Requests".to_owned(), 2),
            ("Team pool Tokens".to_owned(), 0),
        ]
    );
    let facts = |title: &str| {
        report.sections.iter().find_map(|section| match section {
            Section::Facts { title: t, facts } if t == title => Some(facts.clone()),
            _ => None,
        })
    };
    assert_eq!(
        facts("Rate limits").unwrap(),
        [("Team pool Requests".to_owned(), "Unavailable".to_owned())]
    );
    assert_eq!(
        facts("Models").unwrap(),
        [("gpt-4o".to_owned(), "$5.00 · 1.2M tokens".to_owned())]
    );
    assert_eq!(facts("Budgets").unwrap().len(), 2);
}

#[test]
fn overrides_apply_only_while_active() {
    for (mode, cycles, limit) in [
        ("forever", 0, 150.),
        ("cycles", 2, 150.),
        ("cycles", 0, 100.),
        ("paused", 2, 100.),
    ] {
        let body = format!(
            r#"{{"budgets":[{{"id":"b1","max_limit":100,"current_usage":200,
                "override_amount":50,"override_mode":"{mode}","override_cycles_remaining":{cycles}}}]}}"#
        );
        let report = parse(&body, now()).unwrap();
        assert_eq!(report.windows[0].percent(), 100);
        assert_eq!(report.balances[0].total, Some(limit));
        assert_eq!(report.balances[0].amount, 200.);
    }
}

#[test]
fn unlimited_budget_keeps_spend_without_window() {
    let report = parse(
        r#"{"budgets":[{"id":"unlimited","max_limit":0,"current_usage":5}]}"#,
        now(),
    )
    .unwrap();
    assert!(report.windows.is_empty());
    assert_eq!(report.balances[0].label, "Spend");
    assert_eq!(report.balances[0].total, None);
    let empty = parse(r#"{"virtual_key_name":"svc","budgets":null}"#, now()).unwrap();
    assert!(empty.balances.is_empty());
}

#[test]
fn inactive_key_without_quotas_is_rejected() {
    assert!(matches!(
        parse(r#"{"is_active":false,"budgets":null}"#, now()),
        Err(Error::UsageRejected)
    ));
    let report = parse(
        r#"{"is_active":false,"budgets":[{"id":"u","max_limit":0,"current_usage":5}]}"#,
        now(),
    )
    .unwrap();
    assert!(matches!(&report.sections[0], Section::Facts { title, .. } if title == "Virtual key"));
}

#[test]
fn fixed_durations_reset_on_schedule() {
    let body = r#"{"budgets":[{"id":"b1","max_limit":100,"current_usage":1,
            "reset_duration":"1h30m","last_reset":"2026-09-01T00:00:00Z"}]}"#;
    let window = &parse(body, now()).unwrap().windows[0];
    assert_eq!(window.length, Some(Duration::from_secs(90 * 60)));
    assert!(window.resets_at.unwrap() > now());
    assert_eq!(duration("1d"), Some(86_400.));
    assert_eq!(duration("1.5h"), Some(5400.));
    assert_eq!(duration("100ms"), Some(0.1));
    for bad in ["0s", "-1h", "invalid", "1d2h", ""] {
        assert_eq!(duration(bad), None, "{bad}");
    }
}

#[test]
fn normalizes_model_names() {
    assert_eq!(
        model_name("us.anthropic.claude-sonnet-4-20250514-v1:0"),
        "claude-sonnet-4-20250514"
    );
    assert_eq!(model_name("gpt-4o"), "gpt-4o");
    assert_eq!(token_count(1_200_000.), "1.2M");
    assert_eq!(token_count(15_000.), "15K");
}

#[test]
fn builds_quota_url() {
    assert_eq!(
        quota_url("https://bifrost.example.com/").unwrap(),
        "https://bifrost.example.com/api/governance/virtual-keys/quota"
    );
    assert!(quota_url("http://bifrost.example.com").is_err());
    assert!(quota_url("http://127.0.0.1:8080").is_ok());
}
