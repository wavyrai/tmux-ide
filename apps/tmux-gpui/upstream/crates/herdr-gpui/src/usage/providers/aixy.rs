//! Aixy gateway budgets and the key's own seven-day usage from `/v1/usage`,
//! read with a project API key (the `api_key` setting or `AIXY_API_KEY`,
//! here or on the probed host) at `https://api.aixy-gateway.com` or the
//! configured `base_url`. Everything CodexBar reads is ported.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::{gateway, invalid, usd},
    },
};
use serde::Deserialize;
use std::{cmp::Ordering, time::SystemTime};

const BASE: &str = "https://api.aixy-gateway.com";
/// More applicable budgets than this is not a real answer.
const MAX_BUDGETS: usize = 64;

pub(crate) struct Aixy;

static META: Meta = Meta::new("aixy", "Aixy")
    .dashboard("https://dash.aixy-gateway.com")
    .settings(&[
        Setting::new(
            "api_key",
            &["AIXY_API_KEY"],
            "The project-scoped Aixy API key your workload uses, from \
             https://dash.aixy-gateway.com under the project's API keys. Usage is that \
             key's own traffic from every machine.",
        ),
        Setting::new(
            "base_url",
            &["AIXY_BASE_URL"],
            "Optional gateway URL for a self-hosted or dedicated Aixy, with or without /v1. \
             Defaults to https://api.aixy-gateway.com. It must be HTTPS unless it is on \
             localhost, a private network, or a .local host.",
        ),
    ]);

impl Service for Aixy {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("AIXY_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = probe
        .text_setting("base_url")
        .filter(|base| !base.is_empty())
        .unwrap_or_else(|| BASE.to_owned());
    let request = Request::get(usage_url(&base)?)
        .bearer(key)
        .header("Accept", "application/json");
    let body = probe.body(request)?;
    parse(&body)
}

fn usage_url(raw: &str) -> Result<String> {
    let mut url = gateway(raw)?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Error::UsageNotSignedIn);
    }
    let path = url.path().trim_end_matches('/');
    let path = format!("{}/v1/usage", path.strip_suffix("/v1").unwrap_or(path));
    url.set_path(&path);
    Ok(url.to_string())
}

fn text(value: Option<&String>) -> Option<&str> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

/// A dollar amount: finite and never negative.
fn amount(value: Option<f64>) -> Result<Option<f64>> {
    match value {
        Some(value) if !value.is_finite() || value < 0. => Err(invalid()),
        value => Ok(value),
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let usage: KeyUsage = json(body)?;
    if usage.object.as_deref() != Some("key.usage") || usage.currency.as_deref() != Some("USD") {
        return Err(invalid());
    }
    let observed = text(usage.as_of.as_ref()).ok_or_else(invalid)?;
    let key = usage.key.ok_or_else(invalid)?;
    let key_id = text(key.id.as_ref()).ok_or_else(invalid)?;
    let budgets = usage.budgets.ok_or_else(invalid)?;
    if budgets.len() > MAX_BUDGETS {
        return Err(invalid());
    }
    let mut seen = Vec::with_capacity(budgets.len());
    let mut parsed = Vec::with_capacity(budgets.len());
    for budget in &budgets {
        let entry = Entry::new(budget, key_id, key.project_id.as_deref())?;
        if seen.contains(&entry.id) {
            return Err(invalid());
        }
        seen.push(entry.id.clone());
        parsed.push(entry);
    }
    parsed.sort_by(|a, b| {
        b.hard
            .cmp(&a.hard)
            .then(b.used_percent().is_some().cmp(&a.used_percent().is_some()))
            .then(
                b.used_percent()
                    .unwrap_or(0.)
                    .partial_cmp(&a.used_percent().unwrap_or(0.))
                    .unwrap_or(Ordering::Equal),
            )
            .then_with(|| a.id.cmp(&b.id))
    });

    // The two tightest known budgets are the headline windows; overlapping
    // limits are never summed.
    let mut windows: Vec<Window> = Vec::new();
    let mut limits = Vec::new();
    for entry in &parsed {
        let Some(window) = entry.window() else {
            continue;
        };
        if windows.len() < 2 {
            let kind = match entry.interval.kind() {
                Some(kind) if windows.iter().all(|window| window.kind != kind) => kind,
                _ => Kind::Named(entry.short_title()),
            };
            windows.push(Window { kind, ..window });
        } else {
            limits.push(Section::Limit(window));
        }
    }

    let mut sections = vec![Section::Facts {
        title: "Aixy key".into(),
        facts: vec![
            (
                "Key".into(),
                text(key.name.as_ref()).unwrap_or(key_id).to_owned(),
            ),
            (
                "Project".into(),
                text(key.project_name.as_ref())
                    .or(key.project_id.as_deref())
                    .unwrap_or("Unknown")
                    .to_owned(),
            ),
            ("Observed".into(), observed.to_owned()),
        ],
    }];
    sections.extend(limits);
    if !parsed.is_empty() {
        sections.push(Section::Facts {
            title: "Applicable budgets".into(),
            facts: parsed.iter().map(Entry::fact).collect(),
        });
    }
    let mut balances = Vec::new();
    match usage.usage {
        Some(recent) => {
            if recent.window.as_deref() != Some("7d") {
                return Err(invalid());
            }
            let count = |value: Option<f64>| {
                value
                    .filter(|value| value.is_finite() && *value >= 0. && value.fract() == 0.)
                    .ok_or_else(invalid)
            };
            let requests = count(recent.requests)?;
            let tokens = count(recent.total_tokens)?;
            let attributed = count(recent.attributed_requests)?;
            let partial = count(recent.partial_requests)?;
            let spend = amount(recent.spend_usd)?;
            if attributed > requests
                || partial > attributed
                || spend.is_some_and(|spend| spend > 0. && attributed == 0.)
            {
                return Err(invalid());
            }
            if let Some(spend) = spend {
                balances.push(Balance::new(
                    "Last 7 days, attributed",
                    spend,
                    Unit::Currency("USD".into()),
                ));
            }
            sections.push(Section::Facts {
                title: "Last 7 days · this key".into(),
                facts: vec![
                    ("Requests".into(), group(requests as i64)),
                    ("Tokens".into(), group(tokens as i64)),
                    (
                        "Attributed spend".into(),
                        spend.map_or_else(|| "Unavailable".into(), usd),
                    ),
                    (
                        "Cost coverage".into(),
                        format!(
                            "{} / {} requests, {} partial",
                            group(attributed as i64),
                            group(requests as i64),
                            group(partial as i64)
                        ),
                    ),
                ],
            });
        }
        None => sections.push(Section::Facts {
            title: "Last 7 days · this key".into(),
            facts: vec![("Usage".into(), "Unavailable".into())],
        }),
    }
    Ok(Report::new(Provider(&Aixy), Account::default(), windows)
        .with_balances(balances)
        .with_sections(sections))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Interval {
    Daily,
    Weekly,
    Monthly,
    Lifetime,
}

impl Interval {
    fn kind(self) -> Option<Kind> {
        match self {
            Self::Daily => Some(Kind::Daily),
            Self::Weekly => Some(Kind::Weekly),
            Self::Monthly => Some(Kind::Monthly),
            Self::Lifetime => None,
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Daily => "Daily",
            Self::Weekly => "Weekly",
            Self::Monthly => "Monthly",
            Self::Lifetime => "Lifetime",
        }
    }
}

struct Entry {
    id: String,
    scope: &'static str,
    interval: Interval,
    shared: bool,
    hard: bool,
    limit: f64,
    /// Settled spend and, for hard budgets, reservations; None when unknown.
    spent: Option<f64>,
    reserved: f64,
    remaining: Option<f64>,
    starts_at: Option<SystemTime>,
    resets_at: Option<SystemTime>,
}

impl Entry {
    fn new(budget: &BudgetRow, key_id: &str, project: Option<&str>) -> Result<Self> {
        let id = text(budget.id.as_ref()).ok_or_else(invalid)?.to_owned();
        let scope = match text(budget.scope.as_ref()) {
            Some("organization") => "Organization",
            Some("project") => "Project",
            Some("team") => "Team",
            Some("user") => "User",
            Some("api_key") => "Key",
            _ => return Err(invalid()),
        };
        let interval = match text(budget.interval.as_ref()) {
            Some("daily") => Interval::Daily,
            Some("weekly") => Interval::Weekly,
            Some("monthly") => Interval::Monthly,
            Some("lifetime") => Interval::Lifetime,
            _ => return Err(invalid()),
        };
        let hard = match text(budget.enforcement.as_ref()) {
            Some("hard") => true,
            Some("monitor") => false,
            _ => return Err(invalid()),
        };
        let shared = budget.shared.ok_or_else(invalid)?;
        let limit = amount(budget.limit_usd)?
            .filter(|limit| *limit > 0.)
            .ok_or_else(invalid)?;
        // A budget that names another key or project is not this key's.
        let applies = !budget.applies_to.is_empty()
            && budget.applies_to.iter().all(|target| {
                target.api_key_id.as_deref() == Some(key_id)
                    && target.project_id.as_deref() == project
            });
        if !applies {
            return Err(invalid());
        }
        let availability = budget.availability.as_ref().ok_or_else(invalid)?;
        let status = text(availability.status.as_ref());
        if !matches!(status, Some("available" | "unavailable" | "not_enforced")) {
            return Err(invalid());
        }
        let spend_status = text(budget.spend_status.as_ref());
        if !matches!(spend_status, Some("available" | "unavailable")) {
            return Err(invalid());
        }
        let known = if hard {
            status == Some("available")
        } else {
            spend_status == Some("available")
        };
        let (spent, reserved, remaining) = if hard {
            (
                amount(availability.spent_usd)?,
                amount(availability.reserved_usd)?,
                amount(availability.remaining_usd)?,
            )
        } else {
            (
                amount(budget.spend_usd)?,
                Some(0.),
                amount(budget.remaining_usd)?,
            )
        };
        let (spent, reserved, remaining) = if known {
            match (spent, reserved, remaining) {
                (Some(spent), Some(reserved), Some(remaining)) => {
                    (Some(spent), reserved, Some(remaining))
                }
                _ => return Err(invalid()),
            }
        } else {
            (None, 0., None)
        };
        let time = |value: Option<&String>| -> Result<Option<SystemTime>> {
            text(value)
                .map(|value| Timestamp::Text(value.to_owned()).time().ok_or_else(invalid))
                .transpose()
        };
        let starts_at = time(budget.starts_at.as_ref())?;
        let resets_at = time(budget.resets_at.as_ref())?;
        if starts_at
            .zip(resets_at)
            .is_some_and(|(start, end)| end <= start)
        {
            return Err(invalid());
        }
        Ok(Self {
            id,
            scope,
            interval,
            shared,
            hard,
            limit,
            spent,
            reserved,
            remaining,
            starts_at,
            resets_at,
        })
    }

    fn used_percent(&self) -> Option<f64> {
        self.spent
            .map(|spent| ((spent + self.reserved) / self.limit * 100.).min(100.))
    }

    fn title(&self) -> String {
        format!(
            "{} · {} · {} · {}",
            self.scope,
            self.interval.title(),
            if self.shared { "Shared" } else { "Personal" },
            if self.hard { "Hard" } else { "Monitor" },
        )
    }

    fn short_title(&self) -> String {
        format!("{} {}", self.scope, self.interval.title().to_lowercase())
    }

    fn window(&self) -> Option<Window> {
        let length = self
            .starts_at
            .zip(self.resets_at)
            .and_then(|(start, end)| end.duration_since(start).ok());
        Some(Window::new(
            Kind::Named(self.title()),
            self.used_percent()?,
            self.resets_at,
            length,
        ))
    }

    fn fact(&self) -> (String, String) {
        let value = match (self.spent, self.remaining) {
            (Some(spent), Some(remaining)) => {
                let mut value = format!(
                    "{} of {} left, {} spent",
                    usd(remaining),
                    usd(self.limit),
                    usd(spent)
                );
                if self.hard {
                    value.push_str(&format!(", {} reserved", usd(self.reserved)));
                }
                value
            }
            _ => "Unavailable".into(),
        };
        (self.title(), value)
    }
}

#[derive(Deserialize)]
struct KeyUsage {
    object: Option<String>,
    currency: Option<String>,
    as_of: Option<String>,
    key: Option<KeyInfo>,
    usage: Option<RecentUsage>,
    budgets: Option<Vec<BudgetRow>>,
}

#[derive(Deserialize)]
struct KeyInfo {
    id: Option<String>,
    name: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
}

#[derive(Deserialize)]
struct RecentUsage {
    window: Option<String>,
    #[serde(default, deserialize_with = "number")]
    requests: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    total_tokens: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    spend_usd: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    attributed_requests: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    partial_requests: Option<f64>,
}

#[derive(Deserialize)]
struct BudgetRow {
    id: Option<String>,
    scope: Option<String>,
    interval: Option<String>,
    enforcement: Option<String>,
    shared: Option<bool>,
    #[serde(default, deserialize_with = "number")]
    limit_usd: Option<f64>,
    #[serde(default)]
    applies_to: Vec<Target>,
    #[serde(default, deserialize_with = "number")]
    spend_usd: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    remaining_usd: Option<f64>,
    spend_status: Option<String>,
    starts_at: Option<String>,
    resets_at: Option<String>,
    availability: Option<Availability>,
}

#[derive(Deserialize)]
struct Target {
    api_key_id: Option<String>,
    project_id: Option<String>,
}

#[derive(Deserialize)]
struct Availability {
    status: Option<String>,
    #[serde(default, deserialize_with = "number")]
    spent_usd: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    reserved_usd: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    remaining_usd: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const KEY: &str = "11111111-1111-4111-8111-111111111111";
    const PROJECT: &str = "22222222-2222-4222-8222-222222222222";

    fn budget(id: &str, scope: &str, interval: &str, enforcement: &str, extra: &str) -> String {
        format!(
            r#"{{
              "id": "{id}", "object": "cost.personal_budget", "scope": "{scope}",
              "interval": "{interval}", "limit_usd": "100", "warning_threshold_percent": 80,
              "enforcement": "{enforcement}", "allocation": "shared", "shared": {shared},
              "applies_to": [{{"api_key_id": "{KEY}", "api_key_name": "Developer CLI",
                "project_id": "{PROJECT}", "project_name": "Engineering",
                "team_id": null, "team_name": null}}],
              "state": "healthy", {extra}
            }}"#,
            shared = enforcement == "hard",
        )
    }

    fn fixture(usage: &str) -> String {
        let hard = budget(
            "33333333-3333-4333-8333-333333333333",
            "project",
            "monthly",
            "hard",
            r#""spend_usd": "20", "remaining_usd": "80", "utilization_percent": 20,
               "starts_at": "2026-09-01T00:00:00+00:00", "resets_at": "2026-10-01T00:00:00+00:00",
               "spend_status": "available",
               "availability": {"status": "available", "spent_usd": "20",
                                "reserved_usd": "10", "remaining_usd": "70"}"#,
        );
        let monitor = budget(
            "44444444-4444-4444-8444-444444444444",
            "user",
            "weekly",
            "monitor",
            r#""spend_usd": "40", "remaining_usd": "60", "utilization_percent": 40,
               "starts_at": "2026-09-21T00:00:00+00:00", "resets_at": "2026-09-28T00:00:00+00:00",
               "spend_status": "available",
               "availability": {"status": "not_enforced", "spent_usd": null,
                                "reserved_usd": null, "remaining_usd": null}"#,
        );
        let unknown = budget(
            "55555555-5555-4555-8555-555555555555",
            "organization",
            "daily",
            "hard",
            r#""spend_usd": null, "remaining_usd": null,
               "starts_at": "2026-09-24T00:00:00+00:00", "resets_at": "2026-09-25T00:00:00+00:00",
               "spend_status": "unavailable",
               "availability": {"status": "unavailable", "spent_usd": null,
                                "reserved_usd": null, "remaining_usd": null}"#,
        );
        format!(
            r#"{{
              "object": "key.usage", "currency": "USD", "as_of": "2026-09-24T12:00:00+00:00",
              "key": {{"id": "{KEY}", "name": "Developer CLI", "project_id": "{PROJECT}",
                       "project_name": "Engineering"}},
              {usage}
              "budgets": [{hard}, {monitor}, {unknown}]
            }}"#
        )
    }

    const USAGE: &str = r#""usage": {"window": "7d", "requests": 12, "input_tokens": 1000,
        "output_tokens": 200, "total_tokens": 1200, "spend_usd": 1.25,
        "attributed_requests": 10, "estimated_requests": 8, "provider_reported_requests": 1,
        "reconciled_requests": 1, "partial_requests": 2},"#;

    #[test]
    fn parses_budgets_and_recent_usage() {
        let report = parse(&fixture(USAGE)).unwrap();
        assert_eq!(report.windows.len(), 2);
        let monthly = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Monthly)
            .unwrap();
        assert_eq!(monthly.percent(), 30);
        assert_eq!(
            monthly.length.map(|length| length.as_secs()),
            Some(43_200 * 60)
        );
        let weekly = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Weekly)
            .unwrap();
        assert_eq!(weekly.percent(), 40);
        assert_eq!(report.balances[0].amount, 1.25);
        assert_eq!(report.account, Account::default());
        let Section::Facts { title, facts } = &report.sections[0] else {
            panic!("expected key facts");
        };
        assert_eq!(title, "Aixy key");
        assert_eq!(facts[0].1, "Developer CLI");
        let budgets = report
            .sections
            .iter()
            .find_map(|section| match section {
                Section::Facts { title, facts } if title == "Applicable budgets" => Some(facts),
                _ => None,
            })
            .unwrap();
        assert_eq!(budgets[0].0, "Project · Monthly · Shared · Hard");
        assert_eq!(
            budgets[0].1,
            "$70.00 of $100.00 left, $20.00 spent, $10.00 reserved"
        );
        assert_eq!(budgets[1].1, "Unavailable");
    }

    #[test]
    fn missing_usage_is_unavailable_not_zero() {
        let report = parse(&fixture("")).unwrap();
        assert!(report.balances.is_empty());
        assert_eq!(report.windows.len(), 2);
    }

    #[test]
    fn rejects_other_contracts_and_foreign_budgets() {
        assert!(parse(r#"{"object":"list","currency":"USD"}"#).is_err());
        let foreign = fixture(USAGE).replacen(KEY, "99999999-9999-4999-8999-999999999999", 2);
        assert!(parse(&foreign).is_err());
    }

    #[test]
    fn builds_usage_url() {
        assert_eq!(
            usage_url(BASE).unwrap(),
            "https://api.aixy-gateway.com/v1/usage"
        );
        assert_eq!(
            usage_url("https://gw.example.com/aixy/v1/").unwrap(),
            "https://gw.example.com/aixy/v1/usage"
        );
        assert!(usage_url("https://gw.example.com/?x=1").is_err());
        assert!(usage_url("http://gw.example.com").is_err());
        assert!(usage_url("http://10.1.2.3:8080").is_ok());
    }
}
