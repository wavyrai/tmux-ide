use super::*;
use crate::usage::probe::Part;

fn at(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

#[test]
fn parses_team_summary() {
    let report = parse_team(
        r#"{"Success": true, "Data": {"TotalCount": 1, "TotalValue": 1000,
                "TotalSurplusValue": 875, "NearestExpireDate": 1701000000000}, "Code": "200"}"#,
    )
    .unwrap();
    assert_eq!(report.account.plan.as_deref(), Some("TOKEN PLAN"));
    assert_eq!(report.windows[0].kind, Kind::Monthly);
    assert_eq!(report.windows[0].used, 12.5);
    assert_eq!(report.windows[0].resets_at, Some(at(1_701_000_000)));
    assert_eq!(report.balances[0].amount, 875.);
    assert_eq!(report.balances[0].total, Some(1000.));
}

#[test]
fn parses_stringified_team_summary() {
    let body = serde_json::json!({"successResponse": {"body":
        r#"{"success": true, "data": {"totalCount": 1, "totalSurplusValue": 750, "totalValue": 1000}}"#}})
    .to_string();
    let report = parse_team(&body).unwrap();
    assert_eq!(report.windows[0].used, 25.);
}

#[test]
fn empty_team_summary_stays_visible() {
    let report = parse_team(r#"{"Success": true, "Data": {"TotalCount": 0}}"#).unwrap();
    assert!(report.windows.is_empty());
    assert_eq!(report.account.plan, None);
    assert_eq!(report.sections.len(), 1);
}

#[test]
fn parses_personal_usage_with_tier_limits() {
    let usage = expand(serde_json::json!({
        "data": {"DataV2": {"data": r#"{"code":0,"data":{"per5HourPercentage":0.03,
                "per5HourResetTime":1700003600000,"per1WeekPercentage":0.01,
                "per1WeekResetTime":1700086400000},"success":true}"#}},
        "httpStatusCode": 200
    }));
    let subscription = serde_json::json!({"data":{"specCode":"standard","status":"VALID"}});
    let config = serde_json::json!({"data":{"lite":{"five_hour":1000,"weekly":10000},
        "standard":{"five_hour":5000,"weekly":50000}}});
    check(&usage).unwrap();
    let report = personal(
        &usage,
        Some(&subscription),
        Some(&config),
        "Personal",
        false,
    )
    .unwrap()
    .report(Provider(&Alibabatokenplan));
    assert_eq!(report.account.plan.as_deref(), Some("Standard"));
    assert_eq!(report.windows[0].kind, Kind::Session);
    assert!((report.windows[0].used - 3.).abs() < 1e-4);
    assert_eq!(report.windows[0].resets_at, Some(at(1_700_003_600)));
    assert_eq!(report.windows[1].kind, Kind::Weekly);
    assert!((report.windows[1].used - 1.).abs() < 1e-4);
    let Section::Facts { facts, .. } = &report.sections[0] else {
        panic!("expected credit facts");
    };
    assert_eq!(facts[0], ("Session".into(), "150 / 5,000 credits".into()));
}

#[test]
fn cli_requires_numeric_ratios() {
    let report = parse_cli(
        r#"{"per5HourPercentage":0.5,"per5HourResetTime":1700003600000,
                "per1MonthPercentage":0.2,"per1MonthResetTime":1702000000000}"#,
    )
    .unwrap();
    assert_eq!(report.account.plan.as_deref(), Some("Token Plan"));
    assert_eq!(report.windows.len(), 2);
    assert_eq!(report.windows[1].kind, Kind::Monthly);
    assert!(parse_cli(r#"{"per5HourPercentage":"0.5"}"#).is_none());
    assert!(parse_cli("not json").is_none());
}

#[test]
fn maps_gateway_errors() {
    let login = serde_json::json!({"code":"ConsoleNeedLogin","message":"please login"});
    assert!(matches!(check(&login), Err(Error::UsageRejected)));
    let failed = serde_json::json!({"successResponse":true,"data":{"success":false,
        "errorCode":"Throttling","errorMsg":"busy"}});
    assert!(matches!(check(&failed), Err(Error::UsageJson(_))));
    let status = serde_json::json!({"statusCode":500,"message":"oops"});
    assert!(matches!(check(&status), Err(Error::UsageStatus(500))));
    let workspace = serde_json::json!({"success":false,
        "code":"BailianGateway.Workspace.NotAuthorised"});
    assert!(matches!(check(&workspace), Err(Error::UsageJson(_))));
    assert!(check(&serde_json::json!({"code":"200","data":{}})).is_ok());
}

#[test]
fn form_body_splices_the_token_last() {
    let token = Secret::from(secrecy::SecretString::from("tok123".to_owned()));
    let parts = form_body(
        &[("params", r#"{"a":"b c"}"#), ("region", "cn-beijing")],
        Some(&token),
    );
    let Part::Text(text) = &parts[0] else {
        panic!("expected text");
    };
    assert_eq!(
        text,
        "params=%7B%22a%22%3A%22b+c%22%7D&region=cn-beijing&sec_token="
    );
    assert!(matches!(parts[1], Part::Secret(_)));
}

#[test]
fn reads_console_dates() {
    assert_eq!(
        date(&Value::from(1_700_000_000_000_u64)),
        Some(at(1_700_000_000))
    );
    assert_eq!(date(&Value::from("2023-11-14")), Some(at(1_699_920_000)));
    assert_eq!(
        date(&Value::from("2023-11-14 22:13")),
        Some(at(1_700_000_000 - 20))
    );
}
