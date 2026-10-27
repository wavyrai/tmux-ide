//! Chutes subscription and quota usage, read from the management API with an
//! API key: the `api_key` setting (or `CHUTES_API_KEY` here), else
//! `CHUTES_API_KEY` on the probed host. `subscription_usage` is required;
//! when it lacks the rolling four-hour or the monthly window, `quotas` and
//! each quota's `quota_usage/{chute_id}` fill it in, best-effort, as in
//! CodexBar. Chutes' payloads are loosely shaped, so fields are matched by
//! normalized name against CodexBar's candidate lists. Everything CodexBar
//! reads is ported.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, Section, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values,
    },
};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    time::{Duration, SystemTime},
};

const BASE: &str = "https://api.chutes.ai";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Each quota costs one detail request; this bounds a refresh.
const MAX_QUOTAS: usize = 10;
const ROLLING_MINUTES: u64 = 240;
const MONTHLY_MINUTES: u64 = 43_200;

type Object = Map<String, Value>;

pub(crate) struct Chutes;

static META: Meta = Meta::new("chutes", "Chutes")
    .dashboard("https://chutes.ai")
    .settings(&[
        Setting::new(
            "api_key",
            &["CHUTES_API_KEY"],
            "A Chutes API key (cpk_…), created as described at \
             https://chutes.ai/docs/getting-started/authentication.",
        ),
        Setting::new(
            "base_url",
            &["CHUTES_API_URL"],
            "Optional HTTPS management API URL. Defaults to https://api.chutes.ai.",
        ),
    ]);

impl Service for Chutes {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("CHUTES_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = values::https_base(probe.text_setting("base_url"), BASE)?;
    let get = |path: &str| {
        Request::get(format!("{base}/users/me/{path}"))
            .bearer(key)
            .timeout(TIMEOUT)
    };
    let mut parsed = parse(&document(&probe.body(get("subscription_usage"))?)?);
    if parsed.rolling.is_none() || parsed.monthly.is_none() {
        // Quota detail is optional, but must not hide a revoked key.
        match quotas(probe, &get) {
            Ok(quotas) if quotas.has_windows() => {
                parsed.rolling = parsed.rolling.or(quotas.rolling);
                parsed.monthly = parsed.monthly.or(quotas.monthly);
                parsed.fallback.extend(quotas.fallback);
            }
            Err(Error::UsageRejected) => return Err(Error::UsageRejected),
            _ => {}
        }
    }
    Ok(report(parsed))
}

fn quotas(probe: &mut Probe, get: &impl Fn(&str) -> Request) -> Result<Parsed> {
    let raw = document(&probe.body(get("quotas"))?)?;
    let mut parsed = parse(&raw);
    let root = raw.as_object();
    let data = root.and_then(|root| root.get("data"));
    let list = [
        Some(&raw),
        root.and_then(|root| root.get("quotas")),
        data,
        data.and_then(Value::as_object)
            .and_then(|data| data.get("quotas")),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_array);
    let Some(list) = list.filter(|list| list.iter().any(Value::is_object)) else {
        return Ok(parsed);
    };
    let mut enriched = Vec::new();
    for definition in list.iter().filter_map(Value::as_object).take(MAX_QUOTAS) {
        let id = ["chute_id", "chuteId", "id"]
            .into_iter()
            .find_map(|key| text(definition.get(key)?));
        let usage = match id {
            Some(id) => {
                let id: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
                match probe
                    .body(get(&format!("quota_usage/{id}")))
                    .and_then(|body| document(&body))
                {
                    Ok(usage) => Some(usage),
                    Err(Error::UsageRejected) => return Err(Error::UsageRejected),
                    Err(_) => None,
                }
            }
            None => None,
        };
        enriched.push(Value::Object(enrich(definition, usage)));
    }
    let detailed = parse(&Value::Object(Map::from_iter([(
        "quotas".to_owned(),
        Value::Array(enriched),
    )])));
    if detailed.has_windows() {
        parsed = detailed;
    }
    Ok(parsed)
}

/// A quota's definition with its live usage laid over it.
fn enrich(definition: &Object, usage: Option<Value>) -> Object {
    let mut merged = definition.clone();
    let usage = usage.and_then(|usage| match usage {
        Value::Object(mut object) => match ["data", "result"]
            .into_iter()
            .find_map(|key| object.remove(key).filter(Value::is_object))
        {
            Some(Value::Object(inner)) => Some(inner),
            _ => Some(object),
        },
        _ => None,
    });
    merged.extend(usage.into_iter().flatten());
    merged
}

fn document(body: &str) -> Result<Value> {
    let value: Value = json(body)?;
    if value.is_object() || value.is_array() {
        Ok(value)
    } else {
        Err(values::invalid())
    }
}

const ROLLING_KEYS: &[&str] = &[
    "rolling",
    "rollingwindow",
    "rolling4h",
    "fourhour",
    "fourhourusage",
    "window4h",
];
const MONTHLY_KEYS: &[&str] = &[
    "monthly",
    "monthlyusage",
    "subscription",
    "subscriptionusage",
    "billingperiod",
];
const CONTAINER_KEYS: &[&str] = &[
    "quotas",
    "quota",
    "quotausage",
    "limits",
    "usage",
    "entries",
    "subscriptionusage",
];
/// CodexBar also labels a quota by its chute id; an id is no name, so a
/// quota without one is just "Quota" here.
const LABEL_KEYS: &[&str] = &[
    "label",
    "name",
    "title",
    "type",
    "quotatype",
    "period",
    "window",
    "windowname",
];
const LIMIT_KEYS: &[&str] = &[
    "limit",
    "cap",
    "max",
    "maximum",
    "quota",
    "quotalimit",
    "monthlycap",
    "monthlylimit",
    "requestlimit",
    "tokenlimit",
    "hardlimit",
    "total",
];
const USED_KEYS: &[&str] = &[
    "used",
    "usage",
    "usedamount",
    "consumed",
    "consumedamount",
    "current",
    "currentusage",
    "requests",
    "requestcount",
    "tokens",
    "tokenusage",
    "monthlyusage",
];
const REMAINING_KEYS: &[&str] = &[
    "remaining",
    "available",
    "balance",
    "left",
    "remainingamount",
    "availableamount",
];
const PERCENT_USED_KEYS: &[&str] = &[
    "percentused",
    "usagepercent",
    "usedpercent",
    "utilization",
    "utilizationpercent",
];
const PERCENT_REMAINING_KEYS: &[&str] = &["percentremaining", "remainingpercent"];
const RESET_KEYS: &[&str] = &[
    "resetat",
    "resetsat",
    "resettime",
    "nextresetat",
    "renewsat",
    "renewalat",
    "periodend",
    "currentperiodend",
    "expiresat",
    "windowend",
    "endtime",
];
const UNIT_KEYS: &[&str] = &["unit", "units", "currency", "quotaunit"];
const ACTIVE_KEYS: &[&str] = &[
    "active",
    "isactive",
    "subscriptionactive",
    "hassubscription",
];
const STATUS_KEYS: &[&str] = &["status", "state", "subscriptionstatus"];
const PLAN_KEYS: &[&str] = &[
    "planname",
    "plan",
    "tier",
    "subscriptionplan",
    "subscriptiontier",
];

/// The value of the first of `keys` present, comparing names lowercased
/// and without punctuation, so `plan_name` and `planName` both match.
fn lookup<'a>(object: &'a Object, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| {
        object
            .iter()
            .find(|(name, _)| {
                name.chars()
                    .filter(char::is_ascii_alphanumeric)
                    .map(|c| c.to_ascii_lowercase())
                    .eq(key.chars())
            })
            .map(|(_, value)| value)
    })
}

fn number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::String(text) => text.trim().replace([',', '$', '%'], "").parse().ok()?,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::Bool(flag) => Some(if *flag { "1" } else { "0" }.to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) => Some(text.trim().to_owned()).filter(|text| !text.is_empty()),
        _ => None,
    }
}

fn date(value: &Value) -> Option<SystemTime> {
    match value {
        Value::Number(number) => Timestamp::Number(number.as_f64()?).time(),
        Value::String(text) => Timestamp::Text(text.clone()).time(),
        _ => None,
    }
}

fn flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => Some(number.as_f64()? != 0.),
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "true" | "1" | "yes" | "active" => Some(true),
            "false" | "0" | "no" | "inactive" | "none" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn window_minutes(object: &Object) -> Option<u64> {
    let scaled = [
        (
            &["windowminutes", "periodminutes", "durationminutes"][..],
            1.,
        ),
        (&["windowhours", "periodhours", "durationhours"][..], 60.),
        (&["windowdays", "perioddays", "durationdays"][..], 1440.),
        (
            &["windowseconds", "periodseconds", "durationseconds"][..],
            1. / 60.,
        ),
    ]
    .into_iter()
    .find_map(|(keys, scale)| Some(number(lookup(object, keys)?)? * scale));
    let minutes = scaled.or_else(|| {
        let text = text(lookup(
            object,
            &["window", "period", "interval", "duration"],
        )?)?
        .to_lowercase()
        .replace(' ', "");
        let split = text
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|split| *split > 0)?;
        let (amount, unit) = text.split_at(split);
        let amount: f64 = amount.parse().ok()?;
        let scale = if unit.starts_with("min") || unit == "m" {
            1.
        } else if unit.starts_with("hour") || unit.starts_with("hr") || unit == "h" {
            60.
        } else if unit.starts_with("day") || unit == "d" {
            1440.
        } else if unit.starts_with("month") || unit == "mo" {
            43_200.
        } else {
            return None;
        };
        (amount > 0.).then_some(amount * scale)
    })?;
    let minutes = minutes.round();
    (minutes > 0. && minutes < 9.2e18).then_some(minutes as u64)
}

#[derive(Clone, Debug, PartialEq)]
struct Quota {
    /// The object it was read from, to tell the same quota found twice.
    source: String,
    label: Option<String>,
    unit: String,
    used: Option<f64>,
    limit: Option<f64>,
    percent: f64,
    minutes: Option<u64>,
    resets_at: Option<SystemTime>,
}

impl Quota {
    fn read(object: &Object, label: Option<&str>, minutes: Option<u64>) -> Option<Self> {
        let read = |keys: &[&str]| lookup(object, keys).and_then(number);
        let limit = read(LIMIT_KEYS);
        let used = read(USED_KEYS);
        let remaining = read(REMAINING_KEYS);
        // A fraction below one is a ratio, not a percent.
        let normalize = |value: f64| {
            let percent = if value.abs() < 1. {
                value * 100.
            } else {
                value
            };
            percent.clamp(0., 100.)
        };
        let total = limit.or(used
            .zip(remaining)
            .map(|(used, remaining)| used + remaining));
        let consumed = used.or(total
            .zip(remaining)
            .map(|(total, remaining)| total - remaining));
        let percent = read(PERCENT_USED_KEYS)
            .map(normalize)
            .or_else(|| read(PERCENT_REMAINING_KEYS).map(|left| 100. - normalize(left)))
            .or_else(|| {
                let total = total.filter(|total| *total > 0.)?;
                Some(consumed? / total * 100.)
            })?;
        Some(Self {
            source: Value::Object(object.clone()).to_string(),
            label: lookup(object, LABEL_KEYS)
                .and_then(text)
                .or(label.map(str::to_owned)),
            unit: lookup(object, UNIT_KEYS)
                .and_then(text)
                .unwrap_or_else(|| "credits".into()),
            used: used.or(limit
                .zip(remaining)
                .map(|(limit, remaining)| (limit - remaining).max(0.))),
            limit,
            percent: percent.clamp(0., 100.),
            minutes: window_minutes(object).or(minutes),
            resets_at: lookup(object, RESET_KEYS).and_then(date),
        })
    }

    fn is_rolling(&self) -> bool {
        let label = format!("{} {}", self.label.as_deref().unwrap_or(""), self.unit).to_lowercase();
        ["rolling", "4h", "4 h", "4-hour", "four hour", "four-hour"]
            .iter()
            .any(|word| label.contains(word))
            || self.minutes == Some(ROLLING_MINUTES)
    }

    fn is_monthly(&self) -> bool {
        let label = format!("{} {}", self.label.as_deref().unwrap_or(""), self.unit).to_lowercase();
        ["month", "billing", "subscription"]
            .iter()
            .any(|word| label.contains(word))
            || self.minutes.is_some_and(|minutes| minutes >= 40_320)
    }

    fn amounts(&self) -> Option<String> {
        let limit = self.limit.filter(|limit| *limit > 0.)?;
        Some(format!(
            "{}/{} {}",
            values::trimmed(self.used?),
            values::trimmed(limit),
            self.unit
        ))
    }

    fn window(&self, kind: Kind, minutes: Option<u64>, resets_at: Option<SystemTime>) -> Window {
        let length = self
            .minutes
            .or(minutes)
            .map(|minutes| Duration::from_secs(minutes.saturating_mul(60)));
        Window::new(kind, self.percent, self.resets_at.or(resets_at), length)
    }
}

#[derive(Debug, Default)]
struct Parsed {
    rolling: Option<Quota>,
    monthly: Option<Quota>,
    fallback: Vec<Quota>,
    plan: Option<String>,
    active: Option<bool>,
    renewal: Option<SystemTime>,
}

impl Parsed {
    fn has_windows(&self) -> bool {
        self.rolling.is_some() || self.monthly.is_some() || !self.fallback.is_empty()
    }
}

fn parse(value: &Value) -> Parsed {
    let wrapped;
    let root = match value {
        Value::Object(object) => object,
        Value::Array(_) => {
            wrapped = Map::from_iter([("quotas".to_owned(), value.clone())]);
            &wrapped
        }
        _ => return Parsed::default(),
    };
    let data = lookup(root, &["data", "result"])
        .and_then(Value::as_object)
        .unwrap_or(root);
    let dictionary = |keys: &[&str]| {
        lookup(root, keys)
            .and_then(Value::as_object)
            .or_else(|| lookup(data, keys).and_then(Value::as_object))
    };
    let empty = Map::new();
    let subscription = dictionary(&[
        "subscription",
        "subscriptionusage",
        "currentsubscription",
        "plan",
    ])
    .unwrap_or(&empty);
    let context = |keys: &[&str]| {
        [root, data, subscription]
            .into_iter()
            .filter_map(|object| lookup(object, keys))
            .collect::<Vec<_>>()
    };

    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for start in [lookup(root, CONTAINER_KEYS), lookup(data, CONTAINER_KEYS)]
        .into_iter()
        .flatten()
    {
        collect(start, &mut found, &mut seen);
    }
    collect_object(data, &mut found, &mut seen);
    collect_object(root, &mut found, &mut seen);

    let rolling = dictionary(ROLLING_KEYS)
        .and_then(|object| Quota::read(object, Some("4-hour quota"), Some(ROLLING_MINUTES)))
        .or_else(|| found.iter().find(|quota| quota.is_rolling()).cloned());
    let monthly = dictionary(MONTHLY_KEYS)
        .and_then(|object| Quota::read(object, Some("Monthly quota"), Some(MONTHLY_MINUTES)))
        .or_else(|| found.iter().find(|quota| quota.is_monthly()).cloned());
    let active = context(ACTIVE_KEYS).into_iter().find_map(flag).or_else(|| {
        let status = context(STATUS_KEYS)
            .into_iter()
            .find_map(text)?
            .to_lowercase();
        if status.contains("active") && !status.contains("inactive") {
            Some(true)
        } else {
            ["free", "inactive", "cancel", "none", "expired"]
                .iter()
                .any(|word| status.contains(word))
                .then_some(false)
        }
    });
    let taken: Vec<&str> = [&rolling, &monthly]
        .into_iter()
        .flatten()
        .map(|quota| quota.source.as_str())
        .collect();
    let fallback = found
        .iter()
        .filter(|quota| !taken.contains(&quota.source.as_str()))
        .cloned()
        .collect();
    Parsed {
        plan: context(PLAN_KEYS).into_iter().find_map(text),
        renewal: context(RESET_KEYS).into_iter().find_map(date),
        rolling,
        monthly,
        fallback,
        active,
    }
}

/// Every object in `value` that reads as a quota, depth first.
fn collect(value: &Value, found: &mut Vec<Quota>, seen: &mut HashSet<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect(item, found, seen)),
        Value::Object(object) => collect_object(object, found, seen),
        _ => {}
    }
}

fn collect_object(object: &Object, found: &mut Vec<Quota>, seen: &mut HashSet<String>) {
    if let Some(quota) = Quota::read(object, None, None)
        && seen.insert(quota.source.clone())
    {
        found.push(quota);
    }
    object.values().for_each(|item| collect(item, found, seen));
}

fn report(parsed: Parsed) -> Report {
    let rolling = parsed.rolling.as_ref().map(|quota| {
        (
            quota,
            quota.window(Kind::Named("4-hour".into()), Some(ROLLING_MINUTES), None),
        )
    });
    let monthly = parsed.monthly.as_ref().map(|quota| {
        let mut window = quota.window(Kind::Monthly, Some(MONTHLY_MINUTES), parsed.renewal);
        window.length = window.length.or(Some(MONTH));
        (quota, window)
    });
    let mut rest = parsed.fallback.iter().map(|quota| {
        let kind = Kind::Named(quota.label.clone().unwrap_or_else(|| "Quota".into()));
        (quota, quota.window(kind, None, None))
    });
    let shown: Vec<(&Quota, Window)> = match (rolling, monthly) {
        (Some(rolling), Some(monthly)) => vec![rolling, monthly],
        (Some(rolling), None) => [Some(rolling), rest.next()].into_iter().flatten().collect(),
        (None, Some(monthly)) => vec![monthly],
        (None, None) => rest.take(2).collect(),
    };
    let facts: Vec<(String, String)> = shown
        .iter()
        .filter_map(|(quota, window)| Some((window.kind.title().to_owned(), quota.amounts()?)))
        .collect();
    let plan = parsed.plan.or_else(|| match parsed.active {
        Some(false) => Some("No active subscription".into()),
        None if shown.is_empty() => Some("No usage data".into()),
        _ => None,
    });
    Report::new(
        Provider(&Chutes),
        Account { email: None, plan },
        shown.into_iter().map(|(_, window)| window).collect(),
    )
    .with_sections((!facts.is_empty()).then(|| Section::Facts {
        title: "Quota".into(),
        facts,
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn value(body: &str) -> Value {
        document(body).unwrap()
    }

    #[test]
    fn reads_rolling_and_monthly_subscription_windows() {
        let parsed = parse(&value(
            r#"{
                "subscription": {"active": true, "plan_name": "Pro", "current_period_end": "2026-07-01T00:00:00Z"},
                "monthly": {"used": 250, "limit": 1000, "resets_at": "2026-07-01T00:00:00Z", "unit": "credits"},
                "rolling_window": {"requests": 40, "limit": 100, "window_minutes": 240,
                                   "reset_at": "2026-06-13T18:00:00Z", "unit": "requests"}
            }"#,
        ));
        let report = report(parsed);
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        let monthly = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Monthly)
            .unwrap();
        assert_eq!(monthly.used, 25.);
        assert_eq!(
            monthly.resets_at,
            Timestamp::Text("2026-07-01T00:00:00Z".into()).time()
        );
        let rolling = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Named("4-hour".into()))
            .unwrap();
        assert_eq!(rolling.used, 40.);
        assert_eq!(rolling.length, Some(Duration::from_secs(4 * 3600)));
        assert_eq!(
            rolling.resets_at,
            Timestamp::Text("2026-06-13T18:00:00Z".into()).time()
        );
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert!(facts.contains(&("4-hour".into(), "40/100 requests".into())));
        assert!(facts.contains(&("Monthly".into(), "250/1000 credits".into())));
    }

    #[test]
    fn free_accounts_show_quota_usage_from_details() {
        let subscription = parse(&value(
            r#"{"subscription": {"active": false, "status": "free"}}"#,
        ));
        assert!(!subscription.has_windows());
        assert_eq!(subscription.active, Some(false));

        let definition = value(r#"{"chute_id": "0", "is_default": true, "quota": 100}"#);
        let usage = value(r#"{"quota": 100, "used": 10}"#);
        let merged = enrich(definition.as_object().unwrap(), Some(usage));
        let quotas = parse(&Value::Array(vec![Value::Object(merged)]));
        assert!(quotas.has_windows());

        let mut parsed = subscription;
        parsed.fallback.extend(quotas.fallback);
        let report = report(parsed);
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].used, 10.);
        assert_eq!(
            report.account.plan.as_deref(),
            Some("No active subscription")
        );
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts, &[("Quota".into(), "10/100 credits".into())]);
    }

    #[test]
    fn unwraps_detail_envelopes() {
        let definition = value(r#"{"chute_id": "wrapped", "quota": 200}"#);
        let usage = value(r#"{"data": {"quota": 200, "used": 50}}"#);
        let merged = enrich(definition.as_object().unwrap(), Some(usage));
        let parsed = parse(&Value::Array(vec![Value::Object(merged)]));
        assert_eq!(parsed.fallback[0].percent, 25.);
    }

    #[test]
    fn reads_percentages_and_window_text() {
        let parsed = parse(&value(
            r#"{"quotas": [{"name": "Daily", "utilization": 0.25, "window": "24h"}]}"#,
        ));
        let quota = &parsed.fallback[0];
        assert_eq!(quota.percent, 25.);
        assert_eq!(quota.minutes, Some(1440));
    }

    #[test]
    fn empty_payload_reports_no_usage_data() {
        let report = report(parse(&value("{}")));
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("No usage data"));
    }
}
