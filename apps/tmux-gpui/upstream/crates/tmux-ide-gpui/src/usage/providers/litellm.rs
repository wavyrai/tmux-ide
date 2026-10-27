//! LiteLLM budgets and spend from a LiteLLM proxy, read with a virtual key
//! (the `api_key` setting or `LITELLM_API_KEY`, here or on the probed host)
//! at the configured `base_url`: `/key/info`, then the key's `/user/info` or
//! `/team/info`, falling back to the self-scoped `/key/spend/report` and
//! `/user/spend/report` when the deployment hides the info routes. Everything
//! CodexBar reads is ported; no master key is used.

use crate::{
    Error, Result,
    usage::{
        model::{
            Account, Balance, DAY, Kind, MONTH, Provider, Report, Section, Unit, WEEK, Window,
        },
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{gateway, invalid},
    },
};
use chrono::Datelike;
use serde::Deserialize;
use std::time::Duration;

pub(crate) struct Litellm;

static META: Meta = Meta::new("litellm", "LiteLLM").settings(&[
    Setting::new(
        "api_key",
        &["LITELLM_API_KEY"],
        "A LiteLLM virtual key (sk-…) issued by your LiteLLM proxy, e.g. from its admin \
             UI under Virtual Keys. A master key is not needed.",
    ),
    Setting::new(
        "base_url",
        &["LITELLM_BASE_URL"],
        "The LiteLLM proxy's URL, with or without /v1, e.g. \
             https://litellm.example.com. It must be HTTPS unless it is on localhost, a \
             private network, or a .local host.",
    ),
]);

impl Service for Litellm {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("LITELLM_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = probe
        .text_setting("base_url")
        .filter(|base| !base.is_empty())
        .ok_or(Error::UsageNotSignedIn)?;
    let root = root_url(&base)?;
    let get = |path: &str, query: &str| {
        Request::get(format!("{root}/{path}{query}"))
            .bearer(key)
            .header("Accept", "application/json")
    };
    let response = probe.http(get("key/info", ""))?;
    if matches!(response.status, 401 | 403 | 404) {
        let today = chrono::Utc::now().date_naive();
        let end = format!(
            "{:04}-{:02}-{:02}",
            today.year(),
            today.month(),
            today.day()
        );
        let start = format!("{:04}-{:02}-01", today.year(), today.month());
        let query = format!("?start_date={start}&end_date={end}");
        let response = probe.http(get("key/spend/report", &query))?;
        let (scope, body) = if matches!(response.status, 401 | 403 | 404) {
            ("User", probe.body(get("user/spend/report", &query))?)
        } else {
            ("Key", response.ok()?)
        };
        return parse_spend(&body, scope, &start, &end);
    }
    let key_info = parse_key(&response.ok()?)?;
    if let Some(user) = &key_info.user_id {
        let body = probe.body(get("user/info", &format!("?user_id={}", encode(user))))?;
        return parse_user(&body, &key_info);
    }
    let team = key_info.team_id.as_deref().unwrap_or_default();
    let body = probe.body(get("team/info", &format!("?team_id={}", encode(team))))?;
    parse_team(&body, &key_info)
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// The management routes live at the root, not under `/v1`.
fn root_url(raw: &str) -> Result<String> {
    let mut url = gateway(raw)?;
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/v1").unwrap_or(path).to_owned();
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) struct KeyInfo {
    user_id: Option<String>,
    team_id: Option<String>,
    expires: Option<String>,
}

pub(crate) fn parse_key(body: &str) -> Result<KeyInfo> {
    let root: KeyRoot = json(body)?;
    let info = root.info.ok_or_else(invalid)?;
    let key = KeyInfo {
        user_id: nonempty(info.user_id),
        team_id: nonempty(info.team_id),
        expires: nonempty(info.expires),
    };
    if key.user_id.is_none() && key.team_id.is_none() {
        return Err(invalid());
    }
    Ok(key)
}

pub(crate) fn parse_user(body: &str, key: &KeyInfo) -> Result<Report> {
    let root: UserRoot = json(body)?;
    let user = root.user_info.ok_or_else(invalid)?;
    // The answer must be about the key's own user.
    if user
        .user_id
        .as_deref()
        .or(root.user_id.as_deref())
        .is_some_and(|id| Some(id) != key.user_id.as_deref())
    {
        return Err(invalid());
    }
    let preferred = user
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("preferred_username"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let email = nonempty(user.user_email.clone())
        .or_else(|| nonempty(user.user_alias.clone()))
        .or_else(|| nonempty(preferred));
    let personal = user.budget.budget("Personal");
    if root.teams.iter().any(|team| team.team_id.is_none()) {
        return Err(invalid());
    }
    let team = key.team_id.as_deref().and_then(|id| {
        root.teams
            .iter()
            .find(|team| team.team_id.as_deref() == Some(id))
    });
    let team_budget = team.map(|team| team.budget.budget(&team_title(team.team_alias.as_deref())));
    Ok(report(
        email,
        team.and_then(|team| nonempty(team.team_alias.clone())),
        Some(personal),
        team_budget,
        key,
    ))
}

pub(crate) fn parse_team(body: &str, key: &KeyInfo) -> Result<Report> {
    let root: TeamRoot = json(body)?;
    let team = root.team_info.ok_or_else(invalid)?;
    let id = nonempty(team.team_id.clone()).or_else(|| nonempty(root.team_id));
    if id.is_some_and(|id| Some(id.as_str()) != key.team_id.as_deref()) {
        return Err(invalid());
    }
    let budget = team.budget.budget(&team_title(team.team_alias.as_deref()));
    Ok(report(
        None,
        nonempty(team.team_alias),
        None,
        Some(budget),
        key,
    ))
}

fn team_title(alias: Option<&str>) -> String {
    match alias.map(str::trim).filter(|alias| !alias.is_empty()) {
        Some(alias) => format!("Team {alias}"),
        None => "Team".into(),
    }
}

fn report(
    email: Option<String>,
    team: Option<String>,
    personal: Option<Spend>,
    team_budget: Option<Spend>,
    key: &KeyInfo,
) -> Report {
    let windows = [&personal, &team_budget]
        .into_iter()
        .flatten()
        .filter_map(Spend::window)
        .collect();
    let balance = personal
        .as_ref()
        .or(team_budget.as_ref())
        .filter(|spend| spend.used > 0. || spend.limit > 0.)
        .map(|spend| {
            let label = if spend.limit > 0. { "budget" } else { "spend" };
            let balance = Balance::new(
                format!("{} {label}", spend.scope),
                spend.used,
                Unit::Currency("USD".into()),
            );
            if spend.limit > 0. {
                balance.out_of(spend.limit)
            } else {
                balance
            }
        });
    let mut facts = Vec::new();
    if let Some(team) = &team {
        facts.push(("Team".to_owned(), team.clone()));
    }
    if let Some(expires) = &key.expires {
        facts.push((
            "Key expires".to_owned(),
            expires.chars().take(10).collect::<String>(),
        ));
    }
    let key_facts = (!facts.is_empty()).then(|| Section::Facts {
        title: "Key".into(),
        facts,
    });
    let account = Account {
        email,
        plan: Some("API key".into()),
    };
    Report::new(Provider(&Litellm), account, windows)
        .with_balances(balance)
        .with_sections(key_facts)
}

/// Sums a spend report's rows once each: model subtotals are not added again.
pub(crate) fn parse_spend(body: &str, scope: &str, start: &str, end: &str) -> Result<Report> {
    let rows: Vec<SpendRow> = json(body)?;
    if rows.is_empty() {
        return Err(invalid());
    }
    let used = rows.iter().try_fold(0., |total, row| {
        row.total_cost
            .filter(|cost| cost.is_finite() && *cost >= 0.)
            .map(|cost| total + cost)
            .ok_or_else(invalid)
    })?;
    let balance = Balance::new(
        format!("{scope} spend only"),
        used,
        Unit::Currency("USD".into()),
    );
    let period = Section::Facts {
        title: "Spend report".into(),
        facts: vec![("Period".into(), format!("{start} – {end} UTC"))],
    };
    Ok(
        Report::new(Provider(&Litellm), Account::default(), Vec::new())
            .with_balances([balance])
            .with_sections([period]),
    )
}

struct Spend {
    scope: String,
    used: f64,
    limit: f64,
    resets_at: Option<Timestamp>,
    length: Option<Duration>,
}

impl Spend {
    fn window(&self) -> Option<Window> {
        (self.limit > 0.).then(|| {
            Window::new(
                Kind::Named(format!("{} budget", self.scope)),
                self.used / self.limit * 100.,
                self.resets_at.as_ref().and_then(Timestamp::time),
                self.length,
            )
        })
    }
}

/// LiteLLM budget durations: `30s`, `30m`, `24h`, `7d`, `1w`, `1mo`.
fn duration(raw: &str) -> Option<Duration> {
    let raw = raw.trim();
    let split = raw.find(|c: char| !c.is_ascii_digit())?;
    let (count, unit) = raw.split_at(split);
    let count: u32 = count.parse().ok()?;
    let unit = match unit {
        "s" => Duration::from_secs(1),
        "m" => Duration::from_secs(60),
        "h" => Duration::from_secs(3600),
        "d" => DAY,
        "w" => WEEK,
        "mo" => MONTH,
        _ => return None,
    };
    unit.checked_mul(count).filter(|length| !length.is_zero())
}

#[derive(Deserialize)]
struct KeyRoot {
    info: Option<KeyFields>,
}

#[derive(Deserialize)]
struct KeyFields {
    user_id: Option<String>,
    team_id: Option<String>,
    expires: Option<String>,
}

#[derive(Deserialize)]
struct UserRoot {
    user_id: Option<String>,
    user_info: Option<User>,
    #[serde(default)]
    teams: Vec<Team>,
}

#[derive(Deserialize)]
struct User {
    user_id: Option<String>,
    user_email: Option<String>,
    user_alias: Option<String>,
    metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(flatten)]
    budget: Budget,
}

#[derive(Deserialize)]
struct TeamRoot {
    team_id: Option<String>,
    team_info: Option<Team>,
}

#[derive(Deserialize)]
struct Team {
    team_id: Option<String>,
    team_alias: Option<String>,
    #[serde(flatten)]
    budget: Budget,
}

#[derive(Deserialize)]
struct Budget {
    spend: Option<f64>,
    max_budget: Option<f64>,
    budget_duration: Option<String>,
    budget_reset_at: Option<Timestamp>,
}

impl Budget {
    fn budget(&self, scope: &str) -> Spend {
        Spend {
            scope: scope.to_owned(),
            used: self.spend.filter(|spend| spend.is_finite()).unwrap_or(0.),
            limit: self
                .max_budget
                .filter(|limit| limit.is_finite())
                .unwrap_or(0.)
                .max(0.),
            resets_at: self.budget_reset_at.clone(),
            length: self.budget_duration.as_deref().and_then(duration),
        }
    }
}

#[derive(Deserialize)]
struct SpendRow {
    total_cost: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const USER: &str = r#"{
      "user_id": "user-123",
      "user_info": {
        "user_id": "user-123",
        "user_alias": "litellm-user@example.com",
        "max_budget": 300.0,
        "spend": 212.3537162499998,
        "user_email": "litellm-user@example.com",
        "budget_reset_at": null,
        "teams": ["team-456"],
        "metadata": {"source": "keycloak", "preferred_username": "litellm-user@example.com"}
      },
      "keys": [],
      "teams": [
        {"team_alias": "unrelated", "team_id": "team-other", "max_budget": 5.0, "spend": 4.0},
        {
          "team_alias": "ai",
          "team_id": "team-456",
          "max_budget": 1000.0,
          "spend": 215.3245658499998,
          "budget_duration": "7d",
          "budget_reset_at": "2026-06-15T00:00:00Z"
        }
      ]
    }"#;

    #[test]
    fn parses_personal_and_team_budgets() {
        let key = parse_key(
            r#"{"key":"hashed","info":{"key_name":"sk-...IAAw","spend":212.35,
                "expires":"2026-09-11T00:12:55.950000+00:00",
                "user_id":"user-123","team_id":"team-456"}}"#,
        )
        .unwrap();
        let report = parse_user(USER, &key).unwrap();
        assert_eq!(
            report.account.email.as_deref(),
            Some("litellm-user@example.com")
        );
        assert_eq!(report.windows.len(), 2);
        let personal = &report.windows[0];
        assert_eq!(personal.kind, Kind::Named("Personal budget".into()));
        assert_eq!(personal.percent(), 71);
        let team = &report.windows[1];
        assert_eq!(team.kind, Kind::Named("Team ai budget".into()));
        assert_eq!(team.percent(), 22);
        assert_eq!(team.length, Some(WEEK));
        assert!(team.resets_at.is_some());
        assert_eq!(report.balances[0].label, "Personal budget");
        assert_eq!(report.balances[0].total, Some(300.));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected key facts");
        };
        assert_eq!(facts[0], ("Team".into(), "ai".into()));
        assert_eq!(facts[1], ("Key expires".into(), "2026-09-11".into()));
    }

    #[test]
    fn team_only_key_reads_team_info() {
        let key =
            parse_key(r#"{"info":{"key_name":"svc","spend":25,"team_id":"team-456"}}"#).unwrap();
        let body = r#"{"team_id":"team-456","team_info":{"team_id":"team-456",
            "team_alias":"ai","max_budget":100,"spend":25,"budget_duration":"1mo"}}"#;
        let report = parse_team(body, &key).unwrap();
        assert_eq!(report.windows[0].percent(), 25);
        assert_eq!(report.windows[0].length, Some(MONTH));
        assert_eq!(report.balances[0].label, "Team ai budget");
    }

    #[test]
    fn rejects_mismatched_ids() {
        let key = parse_key(r#"{"info":{"user_id":"expected"}}"#).unwrap();
        assert!(parse_user(r#"{"user_info":{"user_id":"other"}}"#, &key).is_err());
        let team = parse_key(r#"{"info":{"team_id":"expected"}}"#).unwrap();
        assert!(parse_team(r#"{"team_info":{"team_id":"other"}}"#, &team).is_err());
        assert!(parse_key(r#"{"info":{}}"#).is_err());
    }

    #[test]
    fn spend_without_budget_has_no_window() {
        let key = parse_key(r#"{"info":{"user_id":"user-123"}}"#).unwrap();
        let body = r#"{"user_info":{"user_id":"user-123","max_budget":null,"spend":12.5}}"#;
        let report = parse_user(body, &key).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Personal spend");
        assert_eq!(report.balances[0].amount, 12.5);
    }

    #[test]
    fn sums_spend_report() {
        let body = r#"[
            {"group_by_day":"2026-09-01","total_cost":1.25,"api_key":"hashed",
             "models":[{"model":"gpt-4o","total_cost":1.25}]},
            {"group_by_day":"2026-09-02","total_cost":0.75}
        ]"#;
        let report = parse_spend(body, "Key", "2026-09-01", "2026-09-02").unwrap();
        assert_eq!(report.balances[0].amount, 2.);
        assert_eq!(report.balances[0].label, "Key spend only");
        assert!(parse_spend("[]", "Key", "a", "b").is_err());
    }

    #[test]
    fn strips_v1_from_base() {
        assert_eq!(
            root_url("https://litellm.example.com/v1/").unwrap(),
            "https://litellm.example.com"
        );
        assert_eq!(
            root_url("http://10.0.0.5:4000/proxy").unwrap(),
            "http://10.0.0.5:4000/proxy"
        );
        assert!(root_url("http://litellm.example.com").is_err());
    }
}
