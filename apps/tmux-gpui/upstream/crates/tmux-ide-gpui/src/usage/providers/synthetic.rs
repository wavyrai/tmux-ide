//! Synthetic quota usage, read from `GET /v2/quotas` with an API key: the
//! `api_key` setting (or `SYNTHETIC_API_KEY` here), else `SYNTHETIC_API_KEY`
//! on the probed host. Synthetic is API-key only, so everything CodexBar
//! reads is ported: the five-hour, weekly-token, and hourly-search lanes, the
//! weekly credit budget, and the generic quota shapes CodexBar falls back to.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Unit, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{invalid, number},
    },
};
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

const URL: &str = "https://api.synthetic.new/v2/quotas";

pub(crate) struct Synthetic;

static META: Meta = Meta::new("synthetic", "Synthetic")
    .dashboard("https://synthetic.new/billing")
    .status_page("https://status.synthetic.new")
    .settings(&[Setting::new(
        "api_key",
        &["SYNTHETIC_API_KEY"],
        "A Synthetic API key, created as described in \
         https://dev.synthetic.new/docs/api/getting-started.",
    )]);

impl Service for Synthetic {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("SYNTHETIC_API_KEY"))?;
        let request = Request::get(URL)
            .bearer(&key)
            .header("Accept", "application/json");
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

const LABEL_KEYS: &[&str] = &["name", "label", "type", "period", "scope", "title", "id"];
const PERCENT_USED_KEYS: &[&str] = &[
    "percentUsed",
    "usedPercent",
    "usagePercent",
    "usage_percent",
    "used_percent",
    "percent_used",
    "percent",
];
const PERCENT_REMAINING_KEYS: &[&str] = &[
    "percentRemaining",
    "remainingPercent",
    "remaining_percent",
    "percent_remaining",
];
const LIMIT_KEYS: &[&str] = &[
    "limit",
    "messageLimit",
    "message_limit",
    "messages",
    "maxRequests",
    "max_requests",
    "requestLimit",
    "request_limit",
    "quota",
    "max",
    "total",
    "capacity",
    "allowance",
];
const USED_KEYS: &[&str] = &[
    "used",
    "usage",
    "usedMessages",
    "used_messages",
    "messagesUsed",
    "messages_used",
    "requests",
    "requestCount",
    "request_count",
    "consumed",
    "spent",
];
const REMAINING_KEYS: &[&str] = &["remaining", "left", "available", "balance"];
const RESET_KEYS: &[&str] = &[
    "resetAt",
    "reset_at",
    "resetsAt",
    "resets_at",
    "renewAt",
    "renew_at",
    "renewsAt",
    "renews_at",
    "nextTickAt",
    "next_tick_at",
    "nextRegenAt",
    "next_regen_at",
    "periodEnd",
    "period_end",
    "expiresAt",
    "expires_at",
    "endAt",
    "end_at",
];
const PLAN_KEYS: &[&str] = &[
    "plan",
    "planName",
    "plan_name",
    "subscription",
    "subscriptionPlan",
    "tier",
    "package",
    "packageName",
];
const GENERIC_KEYS: &[&str] = &[
    "quotas",
    "quota",
    "limits",
    "usage",
    "entries",
    "subscription",
];

type Object = Map<String, Value>;

pub(crate) fn parse(body: &str) -> Result<Report> {
    let root: Value = json(body)?;
    let root = match root {
        Value::Array(items) => Object::from_iter([("quotas".to_owned(), Value::Array(items))]),
        Value::Object(object) => object,
        _ => return Err(invalid()),
    };
    let data = root.get("data").and_then(Value::as_object);
    let slot = |path: &[&str]| {
        [Some(&root), data]
            .into_iter()
            .flatten()
            .find_map(|object| lookup(object, path).filter(|slot| is_quota(slot)))
    };
    let slots = [
        (slot(&["rollingFiveHourLimit"]), Some(Kind::Session)),
        (slot(&["weeklyTokenLimit"]), Some(Kind::Weekly)),
        (
            slot(&["search", "hourly"]),
            Some(Kind::Named("Search hourly".into())),
        ),
    ];
    let quotas: Vec<(Quota, Option<Kind>)> = if slots.iter().any(|(slot, _)| slot.is_some()) {
        slots
            .into_iter()
            .filter_map(|(slot, kind)| Some((parse_quota(slot?)?, kind)))
            .collect()
    } else {
        let mut candidates: Vec<&Value> = GENERIC_KEYS
            .iter()
            .filter_map(|key| root.get(*key))
            .collect();
        candidates.extend(root.get("data"));
        if let Some(data) = data {
            candidates.extend(GENERIC_KEYS.iter().filter_map(|key| data.get(*key)));
        }
        candidates
            .into_iter()
            .map(|candidate| {
                let mut found = Vec::new();
                collect(candidate, &mut found);
                found
            })
            .find(|found| !found.is_empty())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|payload| Some((parse_quota(payload)?, None)))
            .collect()
    };
    if quotas.is_empty() {
        return Err(invalid());
    }
    let balance = quotas
        .iter()
        .find_map(|(quota, _)| quota.credits)
        .map(|(used, limit)| {
            Balance::new(
                "Weekly credits left",
                (limit - used).max(0.),
                Unit::Currency("USD".into()),
            )
            .out_of(limit)
        });
    let windows = quotas
        .into_iter()
        .enumerate()
        .map(|(index, (quota, kind))| quota.window(kind, index))
        .collect();
    let plan = first_string(&root, PLAN_KEYS)
        .or_else(|| data.and_then(|data| first_string(data, PLAN_KEYS)));
    Ok(
        Report::new(Provider(&Synthetic), Account { email: None, plan }, windows)
            .with_balances(balance),
    )
}

struct Quota {
    used: f64,
    resets_at: Option<SystemTime>,
    length: Option<Duration>,
    label: Option<String>,
    /// Weekly credits used and their limit, in dollars.
    credits: Option<(f64, f64)>,
}

impl Quota {
    /// A named lane keeps its kind; a generic quota is known by its length.
    fn window(self, kind: Option<Kind>, index: usize) -> Window {
        let hours = self.length.map(|length| length.as_secs() / 3600);
        let kind = kind.unwrap_or_else(|| match hours {
            Some(5) => Kind::Session,
            Some(24) => Kind::Daily,
            Some(168) => Kind::Weekly,
            Some(720 | 744) => Kind::Monthly,
            _ => Kind::Named(self.label.unwrap_or_else(|| format!("Quota {}", index + 1))),
        });
        let length = self.length.or_else(|| match &kind {
            Kind::Named(name) if name == "Search hourly" => Some(Duration::from_secs(3600)),
            _ => None,
        });
        Window::new(kind, self.used, self.resets_at, length)
    }
}

fn parse_quota(payload: &Object) -> Option<Quota> {
    let mut used = first_number(payload, PERCENT_USED_KEYS)
        .map(normalized_percent)
        .or_else(|| {
            first_number(payload, PERCENT_REMAINING_KEYS)
                .map(|remaining| 100. - normalized_percent(remaining))
        });
    if used.is_none() {
        let mut limit = first_number(payload, LIMIT_KEYS);
        let mut count = first_number(payload, USED_KEYS);
        let remaining = first_number(payload, REMAINING_KEYS);
        if let (None, Some(count), Some(remaining)) = (limit, count, remaining) {
            limit = Some(count + remaining);
        }
        if let (None, Some(limit), Some(remaining)) = (count, limit, remaining) {
            count = Some(limit - remaining);
        }
        if let (Some(limit), Some(count)) = (limit, count)
            && limit > 0.
        {
            used = Some(count / limit * 100.);
        }
    }
    let used = used?.clamp(0., 100.);
    let resets_at = RESET_KEYS
        .iter()
        .filter_map(|key| payload.get(*key))
        .find_map(date);
    let credits = first_currency(payload, &["maxCredits", "max_credits"]).map(|limit| {
        let spent = first_currency(payload, &["usedCredits", "used_credits"])
            .or_else(|| {
                first_currency(payload, &["remainingCredits", "remaining_credits"])
                    .map(|remaining| (limit - remaining).max(0.))
            })
            .unwrap_or(used / 100. * limit);
        (spent, limit)
    });
    Some(Quota {
        used,
        resets_at,
        length: window_minutes(payload).map(|minutes| Duration::from_secs(minutes * 60)),
        label: first_string(payload, LABEL_KEYS),
        credits,
    })
}

fn lookup<'a>(object: &'a Object, path: &[&str]) -> Option<&'a Object> {
    let (first, rest) = path.split_first()?;
    let value = object.get(*first)?.as_object()?;
    if rest.is_empty() {
        Some(value)
    } else {
        lookup(value, rest)
    }
}

fn is_quota(payload: &Object) -> bool {
    [
        LIMIT_KEYS,
        USED_KEYS,
        REMAINING_KEYS,
        PERCENT_USED_KEYS,
        PERCENT_REMAINING_KEYS,
    ]
    .iter()
    .any(|keys| first_number(payload, keys).is_some())
}

/// Every quota object under `value`, keys visited in sorted order as
/// CodexBar does, stopping at the first quota on each branch.
fn collect<'a>(value: &'a Value, found: &mut Vec<&'a Object>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect(item, found)),
        Value::Object(object) if is_quota(object) => found.push(object),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            for key in keys {
                if let Some(child) = object.get(key) {
                    collect(child, found);
                }
            }
        }
        _ => {}
    }
}

fn first_number(payload: &Object, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .filter_map(|key| payload.get(*key))
        .find_map(number)
}

/// `"$36.00"` or `1,250` as a number of dollars.
fn first_currency(payload: &Object, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .filter_map(|key| payload.get(*key))
        .find_map(|value| match value {
            Value::String(text) => text
                .trim()
                .replace(['$', ','], "")
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite()),
            other => number(other),
        })
}

fn first_string(payload: &Object, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| payload.get(*key)?.as_str())
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A fraction up to 1 is a share of the whole; anything above is a percent.
fn normalized_percent(value: f64) -> f64 {
    if value <= 1. { value * 100. } else { value }
}

/// Seconds or milliseconds after 2001, else an ISO 8601 date.
fn date(value: &Value) -> Option<SystemTime> {
    match number(value) {
        Some(number) if number > 1e9 => Timestamp::Number(number).time(),
        Some(_) => None,
        None => Timestamp::Text(value.as_str()?.to_owned()).time(),
    }
}

fn window_minutes(payload: &Object) -> Option<u64> {
    let whole = |value: f64| (value.is_finite() && value > 0.).then(|| value.round() as u64);
    let scaled = [
        (
            &[
                "windowMinutes",
                "window_minutes",
                "periodMinutes",
                "period_minutes",
            ][..],
            1.,
        ),
        (
            &["windowHours", "window_hours", "periodHours", "period_hours"][..],
            60.,
        ),
        (
            &["windowDays", "window_days", "periodDays", "period_days"][..],
            1440.,
        ),
        (
            &[
                "windowSeconds",
                "window_seconds",
                "periodSeconds",
                "period_seconds",
            ][..],
            1. / 60.,
        ),
    ];
    if let Some(minutes) = scaled
        .iter()
        .find_map(|(keys, scale)| first_number(payload, keys).map(|value| value * scale))
    {
        return whole(minutes);
    }
    let text = first_string(
        payload,
        &[
            "window",
            "windowLabel",
            "window_label",
            "period",
            "periodLabel",
            "period_label",
        ],
    )?
    .to_lowercase()
    .replace(char::is_whitespace, "");
    let split = text.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    let (amount, unit) = text.split_at(split);
    let amount: f64 = amount.parse().ok()?;
    let scale = match unit {
        "m" | "min" | "mins" | "minute" | "minutes" => 1.,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60.,
        "d" | "day" | "days" => 1440.,
        _ => return None,
    };
    whole(amount * scale)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    fn at(seconds: f64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs_f64(seconds)
    }

    /// CodexBar's plugin parity fixture.
    const QUOTAS: &str = r#"{
      "plan": "Starter",
      "weeklyTokenLimit": {
        "nextRegenAt": "2026-04-17T05:19:30.000Z",
        "percentRemaining": 98.05884722222223,
        "maxCredits": "$36.00",
        "remainingCredits": "$35.30",
        "nextRegenCredits": "$0.72"
      },
      "rollingFiveHourLimit": {
        "nextTickAt": "2026-04-17T03:44:11.000Z",
        "tickPercent": 0.05,
        "remaining": 600,
        "max": 750,
        "limited": false
      },
      "search": {
        "hourly": {"limit": 250, "requests": 2, "renewsAt": "2026-04-17T04:30:01.494Z"}
      }
    }"#;

    #[test]
    fn reads_the_named_lanes_and_weekly_credits() {
        let report = parse(QUOTAS).unwrap();
        assert_eq!(report.provider.id(), "synthetic");
        assert_eq!(report.account.plan.as_deref(), Some("Starter"));
        let kinds: Vec<_> = report.windows.iter().map(|w| w.kind.clone()).collect();
        assert_eq!(
            kinds,
            [
                Kind::Session,
                Kind::Weekly,
                Kind::Named("Search hourly".into())
            ]
        );
        assert_eq!(report.windows[0].percent(), 20);
        assert_eq!(report.windows[0].resets_at, Some(at(1_776_397_451.)));
        assert!((report.windows[1].used - 1.941_152_8).abs() < 1e-4);
        assert_eq!(report.windows[1].resets_at, Some(at(1_776_403_170.)));
        assert!((report.windows[2].used - 0.8).abs() < 1e-4);
        assert_eq!(report.windows[2].length, Some(Duration::from_secs(3600)));
        let balance = &report.balances[0];
        assert!((balance.amount - 35.3).abs() < 1e-9);
        assert_eq!(balance.total, Some(36.));
        assert_eq!(balance.unit, Unit::Currency("USD".into()));
    }

    #[test]
    fn falls_back_to_generic_quotas() {
        let report = parse(
            r#"{"data":{"tier":"Pro","quotas":[
              {"name":"Daily requests","used":30,"limit":120,"window":"24h","resetAt":1776400000},
              {"name":"Burst","usedPercent":0.5}
            ]}}"#,
        )
        .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.windows[0].kind, Kind::Daily);
        assert_eq!(report.windows[0].percent(), 25);
        assert_eq!(report.windows[0].resets_at, Some(at(1_776_400_000.)));
        assert_eq!(report.windows[1].kind, Kind::Named("Burst".into()));
        assert_eq!(report.windows[1].percent(), 50);
    }

    #[test]
    fn a_response_without_quotas_is_an_error() {
        assert!(matches!(
            parse(r#"{"plan":"Starter"}"#),
            Err(Error::UsageJson(_))
        ));
    }
}
