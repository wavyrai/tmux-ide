//! Notion AI allowance, read from Notion's internal, cookie-authenticated
//! `/api/v3` endpoints on `app.notion.com`, as the web app's Settings > Notion
//! AI > Usage page does: `getSpaces` for the account and its workspaces, then
//! `getCreditRateLimitStatus` for the rolling (6 h) and billing-period
//! windows. The sign-in is the `token_v2` session cookie, from the `cookie`
//! setting or Chrome/Safari. These are not a public API and may change.
//!
//! Not ported: pasting a bare `token_v2` value or a whole cURL capture (the
//! setting takes a `name=value` header, since a secret is never inspected),
//! and CodexBar's persisted session cache. Allowances only exist on Business
//! and Enterprise workspaces; others show that instead of windows.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, Section, Window, title_case},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
        values::invalid,
    },
};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

const BASE: &str = "https://app.notion.com/api/v3";
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const DOMAINS: &[&str] = &[
    "app.notion.com",
    "www.notion.com",
    "notion.com",
    "www.notion.so",
    "notion.so",
];
/// A rolling window no longer than this is paced as a session.
const ROLLING: Duration = Duration::from_secs(6 * 3600);

pub(crate) struct Notion;

static META: Meta = Meta::new("notion", "Notion AI")
    .dashboard("https://app.notion.com")
    .status_page("https://status.notion.so")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "Your Notion session cookie. Sign in at https://app.notion.com, open Developer \
             Tools > Application > Cookies for https://app.notion.com (or notion.so), copy \
             the token_v2 cookie and paste it as \"token_v2=value\" (add \
             \"; notion_user_id=value\" for accounts signed in to several users).",
        ),
        Setting::new(
            "workspace_id",
            &[],
            "The workspace (space) ID to read, dashed or not, for accounts in several \
             workspaces. Defaults to the first Business or Enterprise workspace. It is the \
             x-notion-space-id header of requests in Developer Tools > Network.",
        ),
    ]);

impl Service for Notion {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(DOMAINS, &["token_v2"])?;
        let preferred = probe.text_setting("workspace_id");
        Some(read(probe, &cookie, preferred.as_deref()))
    }
}

fn read(probe: &mut Probe, cookie: &Secret, preferred: Option<&str>) -> Result<Report> {
    let spaces = probe.body(post("getSpaces", cookie, "{}".into()))?;
    let account = parse_spaces(&spaces)?;
    let workspace = account.workspace(preferred).ok_or_else(invalid)?.clone();
    let body = serde_json::json!({ "spaceId": workspace.id }).to_string();
    let status = probe.body(post("getCreditRateLimitStatus", cookie, body))?;
    parse(&status, account.email, &workspace, SystemTime::now())
}

fn post(endpoint: &str, cookie: &Secret, body: String) -> Request {
    Request::post(format!("{BASE}/{endpoint}"))
        .cookie(cookie)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("User-Agent", AGENT)
        .header("Origin", "https://app.notion.com")
        .header("Referer", "https://app.notion.com/")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .json(body)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Workspace {
    id: String,
    name: Option<String>,
    tier: Option<String>,
}

impl Workspace {
    fn may_have_allowance(&self) -> bool {
        self.tier.as_deref().is_some_and(|tier| {
            tier.eq_ignore_ascii_case("business") || tier.eq_ignore_ascii_case("enterprise")
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SignedIn {
    email: Option<String>,
    workspaces: Vec<Workspace>,
}

impl SignedIn {
    /// The configured workspace when the account can see it, else the first
    /// that can have an allowance, else the first.
    fn workspace(&self, preferred: Option<&str>) -> Option<&Workspace> {
        preferred
            .and_then(|preferred| {
                let preferred = space_id(preferred);
                self.workspaces
                    .iter()
                    .find(|workspace| space_id(&workspace.id) == preferred)
            })
            .or_else(|| {
                self.workspaces
                    .iter()
                    .find(|workspace| workspace.may_have_allowance())
            })
            .or_else(|| self.workspaces.first())
    }
}

/// A UUID with or without dashes, lowercased and dashed.
fn space_id(raw: &str) -> String {
    let compact: String = raw.trim().replace('-', "").to_ascii_lowercase();
    if compact.len() != 32 || !compact.bytes().all(|b| b.is_ascii_hexdigit()) {
        return raw.trim().to_ascii_lowercase();
    }
    [0..8, 8..12, 12..16, 16..20, 20..32]
        .into_iter()
        .map(|range| &compact[range])
        .collect::<Vec<_>>()
        .join("-")
}

/// `getSpaces` is keyed by user id; each record is wrapped in one or two
/// `value` objects depending on the response's age.
pub(crate) fn parse_spaces(body: &str) -> Result<SignedIn> {
    let root: Map<String, Value> = json(body)?;
    let identified: Vec<&String> = root
        .iter()
        .filter(|(id, container)| {
            container
                .get("notion_user")
                .and_then(|users| users.get(id.as_str()))
                .and_then(unwrap_record)
                .and_then(|record| record.get("id"))
                .and_then(Value::as_str)
                == Some(id.as_str())
        })
        .map(|(id, _)| id)
        .collect();
    let user = match identified.as_slice() {
        [user] => (*user).clone(),
        [] if root.len() == 1 => root.keys().next().cloned().ok_or_else(invalid)?,
        _ => return Err(invalid()),
    };
    let container = root.get(&user).ok_or_else(invalid)?;
    let email = container
        .get("notion_user")
        .and_then(Value::as_object)
        .and_then(|users| {
            users
                .get(&user)
                .and_then(unwrap_record)
                .or_else(|| users.values().find_map(unwrap_record))
        })
        .and_then(|record| record.get("email"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|email| !email.trim().is_empty());
    let mut workspaces: Vec<Workspace> = container
        .get("space")
        .and_then(Value::as_object)
        .map(|spaces| {
            spaces
                .iter()
                .filter_map(|(key, space)| {
                    let record = unwrap_record(space)?;
                    let text =
                        |name: &str| record.get(name).and_then(Value::as_str).map(str::to_owned);
                    Some(Workspace {
                        id: text("id").unwrap_or_else(|| key.clone()),
                        name: text("name"),
                        tier: text("subscription_tier"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    workspaces.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(SignedIn { email, workspaces })
}

fn unwrap_record(raw: &Value) -> Option<&Map<String, Value>> {
    let outer = raw.as_object()?;
    let Some(value) = outer.get("value").and_then(Value::as_object) else {
        return Some(outer);
    };
    Some(
        value
            .get("value")
            .and_then(Value::as_object)
            .unwrap_or(value),
    )
}

pub(crate) fn parse(
    body: &str,
    email: Option<String>,
    workspace: &Workspace,
    now: SystemTime,
) -> Result<Report> {
    let status: Status = json(body)?;
    let not_applicable = status
        .status
        .as_deref()
        .is_some_and(|status| status.eq_ignore_ascii_case("not_applicable"));
    // Every field is optional, so an unrelated body would otherwise read as
    // an unused allowance.
    if !not_applicable && status.window.is_none() && status.billing_period_window.is_none() {
        return Err(invalid());
    }
    let mut windows = Vec::new();
    if let Some(window) = &status.window
        && let Some(used) = percent(window.used, window.limit)
    {
        let length = window.window.as_deref().and_then(window_length);
        let kind = match length {
            Some(length) if length <= ROLLING => Kind::Session,
            _ => Kind::Named("Rolling".into()),
        };
        let resets_at = status
            .resets_in_seconds
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.)
            .and_then(|seconds| now.checked_add(Duration::from_secs_f64(seconds)));
        windows.push(Window::new(kind, used, resets_at, length));
    }
    if let Some(billing) = &status.billing_period_window
        && let Some(used) = percent(billing.used, billing.limit)
    {
        let resets_at = billing
            .period_end_ms
            .filter(|ms| ms.is_finite() && *ms > 0.)
            .and_then(|ms| SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs_f64(ms / 1000.)));
        windows.push(Window::new(
            Kind::Monthly,
            used,
            resets_at,
            Some(resets_at.and_then(calendar_month).unwrap_or(MONTH)),
        ));
    }
    let mut facts = Vec::new();
    if let Some(name) = workspace
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        facts.push(("Workspace".into(), name.trim().to_owned()));
    }
    if not_applicable {
        facts.push((
            "Allowance".into(),
            "Not tracked; allowances apply to Business and Enterprise workspaces".into(),
        ));
    }
    if let Some(enforcement) = status
        .enforcement
        .as_deref()
        .filter(|enforcement| !enforcement.trim().is_empty())
    {
        facts.push(("Enforcement".into(), title_case(enforcement)));
    }
    let account = Account {
        email,
        plan: workspace
            .tier
            .as_deref()
            .map(title_case)
            .filter(|tier| !tier.is_empty()),
    };
    Ok(
        Report::new(Provider(&Notion), account, windows).with_sections((!facts.is_empty()).then(
            || Section::Facts {
                title: "Notion AI".into(),
                facts,
            },
        )),
    )
}

/// Usage against the returned limit, which need not be 100.
fn percent(used: Option<f64>, limit: Option<f64>) -> Option<f64> {
    let (used, limit) = (used?, limit?);
    (limit > 0. && used.is_finite()).then(|| (used / limit * 100.).max(0.))
}

/// `6h`, `30m`, `1d`, or `1w`.
fn window_length(token: &str) -> Option<Duration> {
    let token = token.trim().to_ascii_lowercase();
    let unit = token.chars().last()?;
    let value: u64 = token[..token.len() - unit.len_utf8()].parse().ok()?;
    let seconds = match unit {
        'm' => 60,
        'h' => 3600,
        'd' => 86_400,
        'w' => 7 * 86_400,
        _ => return None,
    };
    (value > 0).then(|| Duration::from_secs(value.saturating_mul(seconds)))
}

/// The length of the calendar month ending at `end`, so February is paced
/// as 28 days rather than 30.
fn calendar_month(end: SystemTime) -> Option<Duration> {
    let end = chrono::DateTime::<chrono::Utc>::from(end);
    let start = end.checked_sub_months(chrono::Months::new(1))?;
    (end - start).to_std().ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    status: Option<String>,
    window: Option<Rolling>,
    resets_in_seconds: Option<f64>,
    billing_period_window: Option<Billing>,
    enforcement: Option<String>,
}

#[derive(Deserialize)]
struct Rolling {
    window: Option<String>,
    used: Option<f64>,
    limit: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Billing {
    used: Option<f64>,
    limit: Option<f64>,
    period_end_ms: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const SPACES: &str = r#"{
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": {
        "notion_user": {
          "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": {"value": {"value": {
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "email": "person@example.com", "name": "Example Person"}}}
        },
        "space": {
          "66666666-7777-8888-9999-aaaaaaaaaaaa": {"value": {"value": {
            "id": "66666666-7777-8888-9999-aaaaaaaaaaaa", "name": "Personal",
            "plan_type": "personal", "subscription_tier": "free"}}},
          "11111111-2222-3333-4444-555555555555": {"value": {"value": {
            "id": "11111111-2222-3333-4444-555555555555", "name": "Acme",
            "plan_type": "team", "subscription_tier": "business"}}}
        }
      }
    }"#;

    const STATUS: &str = r#"{
      "status": "within_limit",
      "window": {"creditType": "basic_ai_credits", "scope": "per_user", "window": "6h",
                 "used": 42.5, "limit": 100},
      "resetsInSeconds": 12600,
      "billingPeriodWindow": {"creditType": "basic_ai_credits", "scope": "per_user",
        "cadence": "billing_period", "used": 18.0, "limit": 100, "periodEndMs": 1788000000000},
      "enforcement": "preview"
    }"#;

    #[test]
    fn picks_the_business_workspace() {
        let account = parse_spaces(SPACES).unwrap();
        assert_eq!(account.email.as_deref(), Some("person@example.com"));
        assert_eq!(account.workspaces.len(), 2);
        assert_eq!(
            account.workspace(None).unwrap().name.as_deref(),
            Some("Acme")
        );
        let unknown = account.workspace(Some("00000000-0000-0000-0000-000000000000"));
        assert_eq!(unknown.unwrap().name.as_deref(), Some("Acme"));
        let pinned = account
            .workspace(Some("66666666777788889999aaaaaaaaaaaa"))
            .unwrap();
        assert_eq!(pinned.name.as_deref(), Some("Personal"));
    }

    #[test]
    fn parses_singly_wrapped_records() {
        let body = r#"{"u1": {
          "notion_user": {"u1": {"value": {"id": "u1", "email": "legacy@example.com"}}},
          "space": {"s1": {"value": {"id": "s1", "name": "Acme",
                    "subscription_tier": "business"}}}}}"#;
        let account = parse_spaces(body).unwrap();
        assert_eq!(account.email.as_deref(), Some("legacy@example.com"));
        assert_eq!(account.workspaces[0].id, "s1");
    }

    #[test]
    fn parses_both_windows() {
        let account = parse_spaces(SPACES).unwrap();
        let workspace = account.workspace(None).unwrap().clone();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_787_000_000);
        let report = parse(STATUS, account.email.clone(), &workspace, now).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Business"));
        assert_eq!(report.windows.len(), 2);
        let rolling = &report.windows[0];
        assert_eq!(rolling.kind, Kind::Session);
        assert_eq!(rolling.used, 42.5);
        assert_eq!(rolling.length, Some(Duration::from_secs(6 * 3600)));
        assert_eq!(rolling.resets_at, Some(now + Duration::from_secs(12_600)));
        let monthly = &report.windows[1];
        assert_eq!(monthly.kind, Kind::Monthly);
        assert_eq!(monthly.used, 18.);
        assert_eq!(
            monthly.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_788_000_000))
        );
        // 2026-08-29 back to 2026-07-29 is 31 days.
        assert_eq!(monthly.length, Some(Duration::from_secs(31 * 86_400)));
    }

    #[test]
    fn not_applicable_workspace_has_no_windows() {
        let workspace = Workspace {
            id: "s".into(),
            name: Some("Home".into()),
            tier: Some("free".into()),
        };
        let report = parse(
            r#"{"status":"not_applicable"}"#,
            None,
            &workspace,
            SystemTime::now(),
        )
        .unwrap();
        assert!(report.windows.is_empty());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[1].0, "Allowance");
    }

    #[test]
    fn refuses_an_unrelated_body() {
        let workspace = Workspace {
            id: "s".into(),
            name: None,
            tier: None,
        };
        assert!(parse("{}", None, &workspace, SystemTime::now()).is_err());
    }

    #[test]
    fn reads_window_tokens() {
        assert_eq!(window_length("6h"), Some(Duration::from_secs(21_600)));
        assert_eq!(window_length("30m"), Some(Duration::from_secs(1_800)));
        assert_eq!(window_length("0h"), None);
        assert_eq!(window_length("h"), None);
    }
}
