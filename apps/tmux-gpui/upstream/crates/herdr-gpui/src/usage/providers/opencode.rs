//! OpenCode (Zen) usage from the opencode.ai workspace dashboard, signed in
//! with an opencode.ai session cookie: the `cookie` setting, or, when OpenCode
//! is listed in `[usage] show_providers`, the `auth` / `__Host-console_session`
//! cookies imported from Chrome or Safari. As in CodexBar, the workspace comes
//! from the `workspaces` server function (or `workspace_id`), subscription
//! workspaces report rolling five-hour and weekly usage through the
//! `subscription.get` server function, and pay-as-you-go workspaces fall back
//! to the billing server function's monthly spend and prepaid balance.
//!
//! Server functions answer with SolidStart's `$R[..]` JavaScript payload
//! rather than JSON, so fields are read with a tolerant scan like CodexBar's
//! regular expressions. OpenCode keeps no local sign-in for its web console,
//! and its local SQLite history (`opencode.db`) is not read. The helpers here
//! are shared with [`super::opencodego`].

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp},
        values,
    },
};
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

// Shared with [`super::opencodego`] under the name it imports.
pub(super) use crate::usage::values::number as value_number;

pub(super) const BASE: &str = "https://opencode.ai";
pub(super) const DOMAINS: &[&str] = &["opencode.ai"];
/// Either `auth` (legacy pages and server functions) or
/// `__Host-console_session` (the console) is enough, and browser import asks
/// for every name it is given, so all opencode.ai cookies are taken.
pub(super) const COOKIES: &[&str] = &[];
pub(super) const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const WORKSPACES: &str = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const SUBSCRIPTION: &str = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4";
pub(super) const BILLING: &str = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
/// Zen `balance` and `monthlyUsage` are fixed-point USD scaled by 1e8;
/// `monthlyLimit` is whole USD.
pub(super) const MICRO_CENTS: f64 = 100_000_000.;

pub(crate) struct Opencode;

static META: Meta = Meta::new("opencode", "OpenCode")
    .dashboard("https://opencode.ai/auth")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "Your opencode.ai session. Sign in at https://opencode.ai/auth, open Developer \
             Tools > Application > Cookies > https://opencode.ai, and copy the auth and \
             __Host-console_session cookies (either one alone also works). Paste them as \
             \"auth=value; __Host-console_session=value\".",
        ),
        Setting::new(
            "workspace_id",
            &["CODEXBAR_OPENCODE_WORKSPACE_ID"],
            "Optional. The workspace to read, as a wrk_... ID or the \
             https://opencode.ai/workspace/... URL of its dashboard. Defaults to the first \
             workspace of the account.",
        ),
    ]);

impl Service for Opencode {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(DOMAINS, COOKIES)?;
        Some(fetch(probe, &cookie))
    }
}

fn fetch(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let workspace = match probe
        .text_setting("workspace_id")
        .and_then(|raw| workspace_id(&raw))
    {
        Some(workspace) => workspace,
        None => {
            let text = server(probe, cookie, WORKSPACES, None, BASE)?;
            match workspace_ids(&text).into_iter().next() {
                Some(workspace) => workspace,
                None => {
                    let text = server_post(probe, cookie, WORKSPACES, "[]", BASE)?;
                    workspace_ids(&text)
                        .into_iter()
                        .next()
                        .ok_or_else(values::invalid)?
                }
            }
        }
    };
    let args = serde_json::json!([workspace]).to_string();
    let referer = format!("{BASE}/workspace/{workspace}/billing");
    let now = SystemTime::now();
    let mut text = server(probe, cookie, SUBSCRIPTION, Some(&args), &referer)?;
    if !is_null(&text) && usage(&text, now, true).is_none() {
        text = server_post(probe, cookie, SUBSCRIPTION, &args, &referer)?;
    }
    if let Some(windows) = usage(&text, now, true) {
        return Ok(Report::new(
            Provider(&Opencode),
            Account::default(),
            windows,
        ));
    }
    // A pay-as-you-go workspace has no subscription; its spend is billing's.
    let referer = format!("{BASE}/workspace/{workspace}");
    let billing = server(probe, cookie, BILLING, Some(&args), &referer)?;
    parse_billing(&billing).ok_or_else(values::invalid)
}

/// Calls a SolidStart server function with GET, as the dashboard does.
pub(super) fn server(
    probe: &mut Probe,
    cookie: &Secret,
    id: &str,
    args: Option<&str>,
    referer: &str,
) -> Result<String> {
    let mut url = format!("{BASE}/_server?id={id}");
    if let Some(args) = args {
        url.push_str("&args=");
        url.extend(url::form_urlencoded::byte_serialize(args.as_bytes()));
    }
    call(
        probe,
        server_request(Request::get(url), cookie, id, referer),
    )
}

fn server_post(
    probe: &mut Probe,
    cookie: &Secret,
    id: &str,
    args: &str,
    referer: &str,
) -> Result<String> {
    let request = server_request(
        Request::post(format!("{BASE}/_server")),
        cookie,
        id,
        referer,
    )
    .json(args.to_owned());
    call(probe, request)
}

fn server_request(request: Request, cookie: &Secret, id: &str, referer: &str) -> Request {
    request
        .cookie(cookie)
        .header("X-Server-Id", id)
        .header(
            "X-Server-Instance",
            format!("server-fn:{}", uuid::Uuid::new_v4()),
        )
        .header("User-Agent", USER_AGENT)
        .header("Origin", BASE)
        .header("Referer", referer)
        .header(
            "Accept",
            "text/javascript, application/json;q=0.9, */*;q=0.8",
        )
}

/// A legacy page or server function body; a login page means the session
/// is gone even when the status is 200.
pub(super) fn call(probe: &mut Probe, request: Request) -> Result<String> {
    let response = probe.http(request)?;
    if signed_out(&response.body) {
        return Err(Error::UsageRejected);
    }
    response.ok()
}

pub(super) fn signed_out(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "login",
        "sign in",
        "auth/authorize",
        "not associated with an account",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower.contains("actor of type \"public\"")
}

/// A `wrk_…` or console `org_…` ID, alone or inside a dashboard URL.
pub(super) fn workspace_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let start = raw.find("wrk_").or_else(|| raw.find("org_"))?;
    let id: String = raw[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    (id.len() > 4).then_some(id)
}

/// Every quoted `wrk_…` string in a server function payload or JSON body.
pub(super) fn workspace_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for (at, _) in text.match_indices("\"wrk_") {
        let id: String = text[at + 1..].chars().take_while(|c| *c != '"').collect();
        if id.len() > 4
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    ids
}

fn is_null(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.eq_ignore_ascii_case("null") {
        return true;
    }
    // A server function that resolved to null: `…["server-fn:<id>"]=[],null)`.
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    compact.ends_with("]=[],null)")
}

/// The number after `field:` (or `"field":`), skipping a `$R[n]=` reference.
pub(super) fn scan_number(text: &str, field: &str) -> Option<f64> {
    let mut from = 0;
    while let Some(found) = text[from..].find(field) {
        let at = from + found;
        from = at + field.len();
        let before = text[..at].chars().next_back();
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let rest = text[from..].strip_prefix('"').unwrap_or(&text[from..]);
        let Some(rest) = rest.trim_start().strip_prefix(':') else {
            continue;
        };
        let mut rest = rest.trim_start();
        if let Some(reference) = rest.strip_prefix("$R[") {
            let Some(close) = reference.find("]=") else {
                continue;
            };
            rest = reference[close + 2..].trim_start();
        }
        let number: String = rest
            .chars()
            .enumerate()
            .take_while(|(index, c)| c.is_ascii_digit() || *c == '.' || (*index == 0 && *c == '-'))
            .map(|(_, c)| c)
            .collect();
        if let Ok(value) = number.parse::<f64>() {
            return Some(value);
        }
    }
    None
}

/// `field` inside the first `{…}` that follows `scope`, as CodexBar's
/// `scope[^}]*?field` expressions read it.
pub(super) fn scan_scoped(text: &str, scope: &str, field: &str) -> Option<f64> {
    let mut from = 0;
    while let Some(found) = text[from..].find(scope) {
        let at = from + found + scope.len();
        from = at;
        let end = text[at..].find('}').map_or(text.len(), |end| at + end);
        if let Some(value) = scan_number(&text[at..end], field) {
            return Some(value);
        }
    }
    None
}

const PERCENT_KEYS: &[&str] = &[
    "usagePercent",
    "usedPercent",
    "percentUsed",
    "percent",
    "usage_percent",
    "used_percent",
    "utilization",
    "utilizationPercent",
    "utilization_percent",
];
const RESET_IN_KEYS: &[&str] = &[
    "resetInSec",
    "resetInSeconds",
    "resetSeconds",
    "reset_sec",
    "reset_in_sec",
    "resetsInSec",
    "resetsInSeconds",
    "resetIn",
    "resetSec",
];
const RESET_AT_KEYS: &[&str] = &[
    "resetAt",
    "resetsAt",
    "reset_at",
    "resets_at",
    "nextReset",
    "next_reset",
    "renewAt",
    "renew_at",
];

fn first_number(object: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(value_number))
}

/// A usage meter: percent used and when it resets. A direct percent of at
/// most 1 is a fraction when `fractions` is set, as dashboard JSON sends it;
/// the Go API and used/limit pairs are already percentages.
pub(super) fn meter(
    object: &Map<String, Value>,
    now: SystemTime,
    fractions: bool,
) -> Option<(f64, Option<SystemTime>)> {
    let percent = match first_number(object, PERCENT_KEYS) {
        Some(percent) if fractions && (0. ..=1.).contains(&percent) => percent * 100.,
        Some(percent) => percent,
        None => {
            let used = first_number(object, &["used", "usage", "consumed", "usedMicroCents"])?;
            let limit = first_number(object, &["limit", "total", "quota", "limitMicroCents"])
                .filter(|limit| *limit > 0.)?;
            used / limit * 100.
        }
    };
    let reset = first_number(object, RESET_IN_KEYS)
        .filter(|seconds| *seconds >= 0.)
        .and_then(|seconds| now.checked_add(Duration::try_from_secs_f64(seconds).ok()?))
        .or_else(|| {
            RESET_AT_KEYS.iter().find_map(|key| {
                serde_json::from_value::<Timestamp>(object.get(*key)?.clone())
                    .ok()?
                    .time()
            })
        });
    Some((percent, reset))
}

/// Rolling, weekly, and monthly windows from a JSON object holding them
/// under any of the names OpenCode has used, searched a few levels deep.
pub(super) fn json_windows(value: &Value, now: SystemTime, fractions: bool) -> Option<Vec<Window>> {
    fn search(value: &Value, now: SystemTime, fractions: bool, depth: u8) -> Option<Vec<Window>> {
        let object = value.as_object()?;
        let pick = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| object.get(*key)?.as_object())
                .and_then(|window| meter(window, now, fractions))
        };
        if let Some(rolling) = pick(&["rollingUsage", "rolling", "rolling_usage", "rollingWindow"])
        {
            let weekly = pick(&["weeklyUsage", "weekly", "weekly_usage", "weeklyWindow"]);
            let monthly = pick(&["monthlyUsage", "monthly", "monthly_usage", "monthlyWindow"]);
            return Some(windows(Some(rolling), weekly, monthly));
        }
        if depth >= 4 {
            return None;
        }
        object
            .values()
            .find_map(|nested| search(nested, now, fractions, depth + 1))
    }
    search(value, now, fractions, 0)
}

pub(super) fn windows(
    rolling: Option<(f64, Option<SystemTime>)>,
    weekly: Option<(f64, Option<SystemTime>)>,
    monthly: Option<(f64, Option<SystemTime>)>,
) -> Vec<Window> {
    [
        (Kind::Session, rolling),
        (Kind::Weekly, weekly),
        (Kind::Monthly, monthly),
    ]
    .into_iter()
    .filter_map(|(kind, meter)| {
        let (used, reset) = meter?;
        let length = kind.length();
        Some(Window::new(kind, used, reset, length))
    })
    .collect()
}

/// Rolling (and weekly/monthly) usage from a server function payload, JSON
/// or `$R[..]` script.
pub(super) fn usage(text: &str, now: SystemTime, fractions: bool) -> Option<Vec<Window>> {
    if let Ok(value) = serde_json::from_str::<Value>(text)
        && let Some(windows) = json_windows(&value, now, fractions)
    {
        return Some(windows);
    }
    let scanned = |scope: &str| {
        let percent = scan_scoped(text, scope, "usagePercent")?;
        let reset = scan_scoped(text, scope, "resetInSec")
            .filter(|seconds| *seconds >= 0.)
            .and_then(|seconds| now.checked_add(Duration::try_from_secs_f64(seconds).ok()?));
        Some((percent, reset))
    };
    let rolling = scanned("rollingUsage")?;
    Some(windows(
        Some(rolling),
        scanned("weeklyUsage"),
        scanned("monthlyUsage"),
    ))
}

/// Pay-as-you-go spend from the billing server function; None unless the
/// payload names a customer and has no subscription.
pub(crate) fn parse_billing(text: &str) -> Option<Report> {
    let (monthly, limit, balance, subscribed) = match serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| customer(&value).cloned())
    {
        Some(customer) => (
            customer.get("monthlyUsage").and_then(value_number)?,
            customer.get("monthlyLimit").and_then(value_number),
            customer.get("balance").and_then(value_number),
            customer
                .get("subscription")
                .is_some_and(|subscription| !subscription.is_null()),
        ),
        None => {
            if !text.contains("customerID") {
                return None;
            }
            let subscribed = text.match_indices("subscription").any(|(at, _)| {
                let rest = text[at + "subscription".len()..].trim_start_matches('"');
                rest.trim_start()
                    .strip_prefix(':')
                    .is_some_and(|value| !value.trim_start().starts_with("null"))
            });
            (
                scan_number(text, "monthlyUsage")?,
                scan_number(text, "monthlyLimit"),
                scan_number(text, "balance"),
                subscribed,
            )
        }
    };
    if subscribed {
        return None;
    }
    let spent = monthly / MICRO_CENTS;
    let usd = || Unit::Currency("USD".into());
    let mut balances = Vec::new();
    if let Some(balance) = balance {
        balances.push(Balance::new("Zen balance", balance / MICRO_CENTS, usd()));
    }
    if let Some(limit) = limit.filter(|limit| *limit > 0.) {
        balances
            .push(Balance::new("Monthly limit left", (limit - spent).max(0.), usd()).out_of(limit));
    }
    let account = Account {
        email: None,
        plan: Some("Pay as you go".into()),
    };
    Some(
        Report::new(Provider(&Opencode), account, Vec::new())
            .with_balances(balances)
            .with_sections([Section::Facts {
                title: "This month".into(),
                facts: vec![("Spent".into(), format!("${spent:.2}"))],
            }]),
    )
}

fn customer(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if object
                .get("customerID")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
            {
                return Some(object);
            }
            object.values().find_map(customer)
        }
        Value::Array(items) => items.iter().find_map(customer),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::usage::model::SESSION;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn scans_server_function_payload() {
        let now = at(1_700_000_000);
        let text = "$R[16]($R[30],$R[41]={rollingUsage:$R[42]={status:\"ok\",resetInSec:5944,usagePercent:17},\
                    weeklyUsage:$R[43]={status:\"ok\",resetInSec:278201,usagePercent:75}});";
        let windows = usage(text, now, true).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].kind, Kind::Session);
        assert_eq!(windows[0].used, 17.);
        assert_eq!(windows[0].resets_at, Some(at(1_700_005_944)));
        assert_eq!(windows[0].length, Some(SESSION));
        assert_eq!(windows[1].kind, Kind::Weekly);
        assert_eq!(windows[1].used, 75.);
    }

    #[test]
    fn reads_json_usage_with_fractions() {
        let now = at(1_700_000_000);
        let text = r#"{"data":{"usage":{"rollingUsage":{"usagePercent":0.25,"resetInSec":600},
                      "weeklyUsage":{"usagePercent":75,"resetAt":"2023-11-15T00:00:00Z"}}}}"#;
        let windows = usage(text, now, true).unwrap();
        assert_eq!(windows[0].used, 25.);
        assert_eq!(windows[1].used, 75.);
        assert_eq!(windows[1].resets_at, Some(at(1_700_006_400)));
    }

    #[test]
    fn finds_workspaces_and_nulls() {
        let text = r#"$R[0]=[$R[1]={id:"wrk_01ABC",name:"Default"},$R[2]={id:"wrk_02DEF"}]"#;
        assert_eq!(workspace_ids(text), ["wrk_01ABC", "wrk_02DEF"]);
        assert_eq!(
            workspace_id("https://opencode.ai/workspace/wrk_01ABC/billing").as_deref(),
            Some("wrk_01ABC")
        );
        assert!(is_null("null"));
        assert!(is_null(r#"$R["server-fn:0"]=[],null)"#));
        assert!(!is_null(r#"{"rollingUsage":{}}"#));
    }

    #[test]
    fn parses_pay_as_you_go_billing() {
        let report = parse_billing(
            r#"{"customerID":"cus_TEST","balance":500000000,"monthlyLimit":10,
                "monthlyUsage":250000000,"subscription":null}"#,
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Zen balance");
        assert_eq!(report.balances[0].amount, 5.);
        assert_eq!(report.balances[1].amount, 7.5);
        assert_eq!(report.balances[1].total, Some(10.));
        let script = r#"$R[1]={customerID:"cus_TEST",balance:$R[2]=1250000000,monthlyUsage:1500000000,subscription:null}"#;
        let report = parse_billing(script).unwrap();
        assert_eq!(report.balances[0].amount, 12.5);
        assert!(
            parse_billing(
                r#"{"customerID":"cus_TEST","monthlyUsage":1,"subscription":{"id":"sub"}}"#
            )
            .is_none()
        );
        assert!(parse_billing(r#"{"monthlyUsage":1500000000}"#).is_none());
    }

    #[test]
    fn detects_signed_out_pages() {
        assert!(signed_out(
            "<html><a href=\"/auth/authorize\">Sign in</a></html>"
        ));
        assert!(!signed_out("$R[0]={rollingUsage:{usagePercent:1}}"));
    }
}
